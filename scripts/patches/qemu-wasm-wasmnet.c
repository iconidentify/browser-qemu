/*
 * wasmbridge: a QEMU net backend that shuttles raw L2 Ethernet frames between
 * the guest NIC and JavaScript through two single-producer/single-consumer
 * ring buffers in wasm linear memory (which is a SharedArrayBuffer, so it is
 * addressable from both the QEMU pthread and the browser page thread).
 *
 * browser-qemu Phase 1 (ethernet). The relay's slirp does all TCP/IP; this
 * backend is intentionally dumb -- guest TX frames are copied into the TX ring
 * for JS to forward over a WebSocket, and frames JS writes into the RX ring are
 * injected into the guest by a periodic main-loop timer (which runs under the
 * BQL, the only safe place to call qemu_send_packet()).
 *
 * Direction note: this NetClientState is the NIC's peer. qemu_send_packet() on
 * it delivers TO the peer (the dp8393x), i.e. injects into the guest; the
 * .receive callback fires when the guest transmits.
 *
 * Installed into the vendored tree by scripts/build-qemu-m68k-wasm.sh
 * (apply_qemu_wasm_source_patches) as net/wasmbridge.c.
 */
#include "qemu/osdep.h"
#include "qemu/error-report.h"
#include "qemu/timer.h"
#include "qemu/main-loop.h"
#include "net/net.h"
#include "clients.h"
#include "qapi/error.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/threading.h>
#else
#define EMSCRIPTEN_KEEPALIVE
static inline int emscripten_futex_wake(volatile void *addr, int count)
{
    (void)addr; (void)count; return 0;
}
#endif

#define WN_MAGIC        0xC89E7001u   /* 'C89 ethernet', layout version 1 */
#define WN_MAX_FRAME    2048
#define WN_SLOT         (4 + WN_MAX_FRAME)   /* [u32 len LE][payload] */
#define WN_SLOTS        64
#define WN_NCTRL        16
#define WN_RX_POLL_MS   1

/* Control-block int32 slot indices (mirrored in public/net-worker / app.js). */
enum {
    WN_C_MAGIC = 0,
    WN_C_TX_WRITE,   /* producer: QEMU thread */
    WN_C_TX_READ,    /* consumer: page thread  */
    WN_C_RX_WRITE,   /* producer: page thread  */
    WN_C_RX_READ,    /* consumer: QEMU thread  */
    WN_C_READY,
    WN_C_TX_DROP,
    WN_C_RX_DROP,
    WN_C_SLOTS,
    WN_C_STRIDE,
    WN_C_MAXFRAME,
};

/*
 * Single contiguous shared block so JS only needs one base pointer. Layout:
 *   [ ctrl: WN_NCTRL * int32 ][ tx ring ][ rx ring ]
 * Static storage => stable address for the lifetime of the process.
 */
typedef struct WasmNetShared {
    int32_t ctrl[WN_NCTRL];
    uint8_t tx[WN_SLOTS * WN_SLOT];
    uint8_t rx[WN_SLOTS * WN_SLOT];
} WasmNetShared;

static WasmNetShared g_wn_shared;

typedef struct WasmBridgeState {
    NetClientState nc;
    QEMUTimer *rx_timer;
} WasmBridgeState;

static WasmBridgeState *g_wasmbridge;

/* Exported to JS; returns the wasm address of the shared block. */
EMSCRIPTEN_KEEPALIVE uint32_t c89_net_shared_ptr(void)
{
    return (uint32_t)(uintptr_t)&g_wn_shared;
}

static inline int32_t wn_load_acq(const int32_t *p)
{
    return __atomic_load_n(p, __ATOMIC_ACQUIRE);
}

static inline void wn_store_rel(int32_t *p, int32_t v)
{
    __atomic_store_n(p, v, __ATOMIC_RELEASE);
}

/* Guest transmitted a frame: copy it into the TX ring for JS to forward. */
static ssize_t wasmbridge_receive(NetClientState *nc,
                                  const uint8_t *buf, size_t size)
{
    int32_t *ctrl = g_wn_shared.ctrl;
    int32_t w, r;
    uint8_t *slot;

    if (size == 0) {
        return 0;
    }
    if (size > WN_MAX_FRAME) {
        /* Oversized; drop but report consumed so the NIC does not stall. */
        ctrl[WN_C_TX_DROP]++;
        return size;
    }

    w = wn_load_acq(&ctrl[WN_C_TX_WRITE]);
    r = wn_load_acq(&ctrl[WN_C_TX_READ]);
    if ((uint32_t)(w - r) >= WN_SLOTS) {
        /* Ring full: drop. JS is not draining fast enough. */
        ctrl[WN_C_TX_DROP]++;
        return size;
    }

    slot = g_wn_shared.tx + ((uint32_t)w % WN_SLOTS) * WN_SLOT;
    slot[0] = (uint8_t)(size & 0xff);
    slot[1] = (uint8_t)((size >> 8) & 0xff);
    slot[2] = (uint8_t)((size >> 16) & 0xff);
    slot[3] = (uint8_t)((size >> 24) & 0xff);
    memcpy(slot + 4, buf, size);

    /* Publish the payload before advancing the write index. */
    wn_store_rel(&ctrl[WN_C_TX_WRITE], w + 1);
    emscripten_futex_wake(&ctrl[WN_C_TX_WRITE], 1);
    return size;
}

static bool wasmbridge_can_receive(NetClientState *nc)
{
    return true;
}

/* Main-loop timer (under BQL): inject any frames JS queued into the guest. */
static void wasmbridge_rx_poll(void *opaque)
{
    WasmBridgeState *s = opaque;
    int32_t *ctrl = g_wn_shared.ctrl;
    int guard = 0;

    for (;;) {
        int32_t w = wn_load_acq(&ctrl[WN_C_RX_WRITE]);
        int32_t r = wn_load_acq(&ctrl[WN_C_RX_READ]);
        uint8_t *slot;
        uint32_t len;

        if (w == r) {
            break;
        }
        slot = g_wn_shared.rx + ((uint32_t)r % WN_SLOTS) * WN_SLOT;
        len = (uint32_t)slot[0] | ((uint32_t)slot[1] << 8) |
              ((uint32_t)slot[2] << 16) | ((uint32_t)slot[3] << 24);
        if (len > 0 && len <= WN_MAX_FRAME) {
            qemu_send_packet(&s->nc, slot + 4, len);
        } else {
            ctrl[WN_C_RX_DROP]++;
        }
        /* Release the slot back to the producer. */
        wn_store_rel(&ctrl[WN_C_RX_READ], r + 1);

        if (++guard >= WN_SLOTS) {
            break; /* bound work per tick */
        }
    }

    timer_mod(s->rx_timer,
              qemu_clock_get_ms(QEMU_CLOCK_REALTIME) + WN_RX_POLL_MS);
}

static void wasmbridge_cleanup(NetClientState *nc)
{
    WasmBridgeState *s = DO_UPCAST(WasmBridgeState, nc, nc);

    if (s->rx_timer) {
        timer_free(s->rx_timer);
        s->rx_timer = NULL;
    }
    g_wn_shared.ctrl[WN_C_READY] = 0;
    if (g_wasmbridge == s) {
        g_wasmbridge = NULL;
    }
}

static NetClientInfo net_wasmbridge_info = {
    .type = NET_CLIENT_DRIVER_WASMBRIDGE,
    .size = sizeof(WasmBridgeState),
    .can_receive = wasmbridge_can_receive,
    .receive = wasmbridge_receive,
    .cleanup = wasmbridge_cleanup,
};

int net_init_wasmbridge(const Netdev *netdev, const char *name,
                        NetClientState *peer, Error **errp)
{
    NetClientState *nc;
    WasmBridgeState *s;
    int32_t *ctrl;

    if (g_wasmbridge) {
        error_setg(errp, "wasmbridge supports a single instance");
        return -1;
    }

    nc = qemu_new_net_client(&net_wasmbridge_info, peer, "wasmbridge", name);
    s = DO_UPCAST(WasmBridgeState, nc, nc);
    g_wasmbridge = s;

    ctrl = g_wn_shared.ctrl;
    memset(&g_wn_shared, 0, sizeof(g_wn_shared));
    ctrl[WN_C_SLOTS] = WN_SLOTS;
    ctrl[WN_C_STRIDE] = WN_SLOT;
    ctrl[WN_C_MAXFRAME] = WN_MAX_FRAME;
    /* Publish MAGIC last-ish; READY gates JS use after the timer is armed. */
    wn_store_rel(&ctrl[WN_C_MAGIC], (int32_t)WN_MAGIC);

    s->rx_timer = timer_new_ms(QEMU_CLOCK_REALTIME, wasmbridge_rx_poll, s);
    timer_mod(s->rx_timer,
              qemu_clock_get_ms(QEMU_CLOCK_REALTIME) + WN_RX_POLL_MS);

    wn_store_rel(&ctrl[WN_C_READY], 1);
    info_report("c89 wasmbridge net backend ready (shared block at %u, "
                "%d slots x %d bytes)", c89_net_shared_ptr(),
                WN_SLOTS, WN_SLOT);
    return 0;
}
