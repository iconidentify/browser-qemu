/*
 * wasminput: browser-qemu input bridge.
 *
 * JavaScript writes browser keyboard and pointer events into this shared block
 * in wasm linear memory. A QEMU main-loop timer drains it and injects directly
 * into the q800 ADB keyboard/mouse devices. This keeps headed browser input off
 * the HMP monitor path and shares browser-to-ADB mappings with 68k_web.
 */
#include "qemu/osdep.h"
#include "qemu/error-report.h"
#include "qemu/module.h"
#include "qemu/timer.h"
#include "hw/input/adb.h"
#include "exec/address-spaces.h"
#include "exec/memory.h"
#include "sysemu/sysemu.h"
#include "ui/console.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#define WI_MAGIC       0xC8917001u
#define WI_VERSION     6
#define WI_NCTRL       70
#define WI_KEY_SLOTS   128
#define WI_KEY_STRIDE  4
#define WI_CURSOR_BYTES 64
#define WI_BUTTON_QUEUE_SLOTS 8
#ifndef C89_WI_KEY_EVENTS_PER_POLL
#define C89_WI_KEY_EVENTS_PER_POLL 1
#endif
#define WI_MAC_THECRSR  0x844
#define WI_MAC_CRSR_VIS 0x8cc
#define WI_MAC_CRSR_NEW 0x8ce
#define WI_MAC_CRSR_COUPLE 0x8cf
#define WI_MAC_CRSR_STATE 0x8d0
#define WI_MAC_DRAW_CRSR_VECTOR 0x1fb8
#define WI_MAC_ERASE_CRSR_VECTOR 0x1fbc
#define WI_MAC_ROM_BASE 0x40800000u
#define WI_MAC_ROM_SCAN_BYTES 0x00100000u
#ifndef C89_WI_POLL_MS
#define C89_WI_POLL_MS 15
#endif
#ifndef C89_WI_MAX_ADB_DELTA
#define C89_WI_MAX_ADB_DELTA 63
#endif

enum {
    WI_C_MAGIC = 0,
    WI_C_READY,
    WI_C_VERSION,
    WI_C_REL_DX,
    WI_C_REL_DY,
    WI_C_ABS_X,
    WI_C_ABS_Y,
    WI_C_ABS_FLAGS,
    WI_C_BUTTONS,
    WI_C_KEY_WRITE,
    WI_C_KEY_READ,
    WI_C_KEY_DROP,
    WI_C_KEY_SLOTS,
    WI_C_KEY_STRIDE,
    WI_C_POLL_MS,
    WI_C_MOUSE_EVENTS,
    WI_C_KEY_EVENTS,
    WI_C_BUTTON_EVENTS,
    WI_C_LAST_QCODE,
    WI_C_LAST_ADB,
    WI_C_LAST_BUTTONS,
    WI_C_ABS_WIDTH,
    WI_C_ABS_HEIGHT,
    WI_C_CURSOR_SEQ,
    WI_C_CURSOR_HOT_X,
    WI_C_CURSOR_HOT_Y,
    WI_C_CURSOR_VALID,
    WI_C_CURSOR_OFFSET,
    WI_C_CURSOR_BYTES,
    WI_C_MOUSE_ABS_SYNCS,
    WI_C_LAST_MOUSE_DX,
    WI_C_LAST_MOUSE_DY,
    WI_C_MAC_MTEMP_X,
    WI_C_MAC_MTEMP_Y,
    WI_C_MAC_RAW_X,
    WI_C_MAC_RAW_Y,
    WI_C_MAC_MOUSE_X,
    WI_C_MAC_MOUSE_Y,
    WI_C_MAC_CRSR_NEW,
    WI_C_MAC_CRSR_COUPLE,
    WI_C_LAST_SYNC_X,
    WI_C_LAST_SYNC_Y,
    WI_C_LAST_ABS_FLAGS,
    WI_C_LAST_ADB_BUTTONS,
    WI_C_LAST_ABS_EVENT_X,
    WI_C_LAST_ABS_EVENT_Y,
    WI_C_LAST_ABS_EVENT_W,
    WI_C_LAST_ABS_EVENT_H,
    WI_C_ADB_POS_X,
    WI_C_ADB_POS_Y,
    WI_C_ADB_PENDING_DX,
    WI_C_ADB_PENDING_DY,
    WI_C_ADB_STATE_BUTTONS,
    WI_C_ADB_LAST_BUTTONS,
    WI_C_ADB_DESIRED_BUTTONS,
    WI_C_ADB_QUEUE_DEPTH,
    WI_C_ADB_LAST_POLL_BEFORE_X,
    WI_C_ADB_LAST_POLL_BEFORE_Y,
    WI_C_ADB_LAST_POLL_AFTER_X,
    WI_C_ADB_LAST_POLL_AFTER_Y,
    WI_C_ADB_LAST_POLL_DX,
    WI_C_ADB_LAST_POLL_DY,
    WI_C_ADB_LAST_POLL_BUTTONS,
    WI_C_ADB_POLL_COUNT,
    WI_C_ADB_EMPTY_POLL_COUNT,
    WI_C_LOCAL_BUTTON_QUEUE_DEPTH,
    WI_C_TARGET_PENDING,
    WI_C_CURSOR_SUPPRESS,
    WI_C_CURSOR_SUPPRESS_ACTIVE,
    WI_C_CURSOR_SUPPRESS_TRANSITIONS,
};

typedef struct WasmInputShared {
    int32_t ctrl[WI_NCTRL];
    int32_t keys[WI_KEY_SLOTS][WI_KEY_STRIDE];
    uint8_t cursor[WI_CURSOR_BYTES];
} WasmInputShared;

static WasmInputShared g_wi_shared;
static QEMUTimer *g_wi_timer;
static Notifier g_wi_machine_done;
static uint32_t g_wi_last_buttons;
static uint8_t g_wi_last_cursor[WI_CURSOR_BYTES];
static uint8_t g_wi_last_cursor_hot_x;
static uint8_t g_wi_last_cursor_hot_y;
static bool g_wi_last_cursor_valid;
static uint32_t g_wi_cursor_rts_addr;
static bool g_wi_cursor_hardware_active;
static bool g_wi_cursor_suppression_logged;
static bool g_wi_abs_valid;
static int32_t g_wi_abs_x;
static int32_t g_wi_abs_y;
static int32_t g_wi_last_sync_x;
static int32_t g_wi_last_sync_y;
static bool g_wi_hybrid_motion_active;
static bool g_wi_adb_pos_valid;
static int32_t g_wi_adb_x;
static int32_t g_wi_adb_y;
static int g_wi_seen_adb_buttons;
static int g_wi_button_queue[WI_BUTTON_QUEUE_SLOTS];
static uint32_t g_wi_button_queue_read;
static uint32_t g_wi_button_queue_write;

EMSCRIPTEN_KEEPALIVE uint32_t c89_input_shared_ptr(void)
{
    return (uint32_t)(uintptr_t)&g_wi_shared;
}

static inline int32_t wi_load_acq(const int32_t *p)
{
    return __atomic_load_n(p, __ATOMIC_ACQUIRE);
}

static inline void wi_store_rel(int32_t *p, int32_t v)
{
    __atomic_store_n(p, v, __ATOMIC_RELEASE);
}

static inline int32_t wi_exchange_i32(int32_t *p, int32_t v)
{
    return __atomic_exchange_n(p, v, __ATOMIC_ACQ_REL);
}

static uint16_t wi_read_u16_be(hwaddr addr, bool *ok);
static uint8_t wi_read_u8(hwaddr addr, bool *ok);

static void wi_sync_mac_mouse_lowmem(int x, int y)
{
    MemTxResult res;
    uint8_t crsr_couple;

    /*
     * Classic Mac low-memory mouse globals are Points stored as (v,h).
     * Keeping all three locations fresh mirrors the 68k_web/BasiliskII fix:
     * - MTemp   0x828/0x82a
     * - RawMouse 0x82c/0x82e
     * - Mouse   0x830/0x832 (Event Manager click coordinates)
     */
    address_space_stw_be(&address_space_memory, 0x82a, x,
                         MEMTXATTRS_UNSPECIFIED, &res);
    address_space_stw_be(&address_space_memory, 0x828, y,
                         MEMTXATTRS_UNSPECIFIED, &res);
    address_space_stw_be(&address_space_memory, 0x82e, x,
                         MEMTXATTRS_UNSPECIFIED, &res);
    address_space_stw_be(&address_space_memory, 0x82c, y,
                         MEMTXATTRS_UNSPECIFIED, &res);
    address_space_stw_be(&address_space_memory, 0x832, x,
                         MEMTXATTRS_UNSPECIFIED, &res);
    address_space_stw_be(&address_space_memory, 0x830, y,
                         MEMTXATTRS_UNSPECIFIED, &res);

    /*
     * Match 68k_web/BasiliskII's absolute-mouse fix: after updating the mouse
     * Points, ask the Mac cursor machinery to reconcile against the fresh raw
     * position. Without this, the Event Manager and cursor bookkeeping can get
     * one update out of phase in hardware-cursor mode.
     */
    crsr_couple = address_space_ldub(&address_space_memory,
                                     WI_MAC_CRSR_COUPLE,
                                     MEMTXATTRS_UNSPECIFIED, &res);
    address_space_stb(&address_space_memory, WI_MAC_CRSR_NEW, crsr_couple,
                      MEMTXATTRS_UNSPECIFIED, &res);
    g_wi_last_sync_x = x;
    g_wi_last_sync_y = y;
}

static int32_t wi_read_mac_point_coord(hwaddr addr)
{
    bool ok = false;
    uint16_t value = wi_read_u16_be(addr, &ok);
    return ok ? (int16_t)value : INT32_MIN;
}

static void wi_refresh_mac_mouse_diag(int32_t *ctrl)
{
    bool ok = false;

    ctrl[WI_C_MAC_MTEMP_X] = wi_read_mac_point_coord(0x82a);
    ctrl[WI_C_MAC_MTEMP_Y] = wi_read_mac_point_coord(0x828);
    ctrl[WI_C_MAC_RAW_X] = wi_read_mac_point_coord(0x82e);
    ctrl[WI_C_MAC_RAW_Y] = wi_read_mac_point_coord(0x82c);
    ctrl[WI_C_MAC_MOUSE_X] = wi_read_mac_point_coord(0x832);
    ctrl[WI_C_MAC_MOUSE_Y] = wi_read_mac_point_coord(0x830);
    ctrl[WI_C_MAC_CRSR_NEW] = wi_read_u8(WI_MAC_CRSR_NEW, &ok);
    ctrl[WI_C_MAC_CRSR_COUPLE] = wi_read_u8(WI_MAC_CRSR_COUPLE, &ok);
    ctrl[WI_C_LAST_SYNC_X] = g_wi_last_sync_x;
    ctrl[WI_C_LAST_SYNC_Y] = g_wi_last_sync_y;
}

static int32_t wi_clamp_adb_delta(int32_t value)
{
    if (value < -C89_WI_MAX_ADB_DELTA) {
        return -C89_WI_MAX_ADB_DELTA;
    }
    if (value > C89_WI_MAX_ADB_DELTA) {
        return C89_WI_MAX_ADB_DELTA;
    }
    return value;
}

static bool wi_button_queue_empty(void)
{
    return g_wi_button_queue_read == g_wi_button_queue_write;
}

static void wi_queue_button_transition(int buttons)
{
    uint32_t next = (g_wi_button_queue_write + 1) % WI_BUTTON_QUEUE_SLOTS;

    if (next == g_wi_button_queue_read) {
        g_wi_button_queue_read =
            (g_wi_button_queue_read + 1) % WI_BUTTON_QUEUE_SLOTS;
    }

    g_wi_button_queue[g_wi_button_queue_write] = buttons;
    g_wi_button_queue_write = next;
}

static bool wi_dequeue_button_transition(int *buttons)
{
    if (wi_button_queue_empty()) {
        return false;
    }

    *buttons = g_wi_button_queue[g_wi_button_queue_read];
    g_wi_button_queue_read =
        (g_wi_button_queue_read + 1) % WI_BUTTON_QUEUE_SLOTS;
    return true;
}

static uint32_t wi_button_queue_depth(void)
{
    if (g_wi_button_queue_write >= g_wi_button_queue_read) {
        return g_wi_button_queue_write - g_wi_button_queue_read;
    }
    return WI_BUTTON_QUEUE_SLOTS - g_wi_button_queue_read +
           g_wi_button_queue_write;
}

static bool wi_read_mac_mouse_point(int32_t *x, int32_t *y)
{
    int32_t mouse_x = wi_read_mac_point_coord(0x832);
    int32_t mouse_y = wi_read_mac_point_coord(0x830);

    if (mouse_x == INT32_MIN || mouse_y == INT32_MIN) {
        return false;
    }

    *x = mouse_x;
    *y = mouse_y;
    return true;
}

static void wi_refresh_adb_debug(int32_t *ctrl)
{
    C89ADBMouseDebug debug;

    memset(&debug, 0, sizeof(debug));
    if (c89_adb_mouse_get_debug(&debug)) {
        ctrl[WI_C_ADB_POS_X] = debug.abs_x;
        ctrl[WI_C_ADB_POS_Y] = debug.abs_y;
        ctrl[WI_C_ADB_PENDING_DX] = debug.pending_dx;
        ctrl[WI_C_ADB_PENDING_DY] = debug.pending_dy;
        ctrl[WI_C_ADB_STATE_BUTTONS] = debug.buttons_state;
        ctrl[WI_C_ADB_LAST_BUTTONS] = debug.last_buttons_state;
        ctrl[WI_C_ADB_DESIRED_BUTTONS] = debug.desired_buttons;
        ctrl[WI_C_ADB_QUEUE_DEPTH] = debug.queue_depth;
        ctrl[WI_C_ADB_LAST_POLL_BEFORE_X] = debug.last_poll_before_x;
        ctrl[WI_C_ADB_LAST_POLL_BEFORE_Y] = debug.last_poll_before_y;
        ctrl[WI_C_ADB_LAST_POLL_AFTER_X] = debug.last_poll_after_x;
        ctrl[WI_C_ADB_LAST_POLL_AFTER_Y] = debug.last_poll_after_y;
        ctrl[WI_C_ADB_LAST_POLL_DX] = debug.last_poll_dx;
        ctrl[WI_C_ADB_LAST_POLL_DY] = debug.last_poll_dy;
        ctrl[WI_C_ADB_LAST_POLL_BUTTONS] = debug.last_poll_buttons;
        ctrl[WI_C_ADB_POLL_COUNT] = (int32_t)debug.poll_count;
        ctrl[WI_C_ADB_EMPTY_POLL_COUNT] = (int32_t)debug.empty_poll_count;
    }

    ctrl[WI_C_LOCAL_BUTTON_QUEUE_DEPTH] = (int32_t)wi_button_queue_depth();
}

static void wi_seed_adb_position_from_mac_mouse(void)
{
    int32_t mouse_x;
    int32_t mouse_y;

    if (g_wi_adb_pos_valid) {
        return;
    }

    if (wi_read_mac_mouse_point(&mouse_x, &mouse_y)) {
        g_wi_adb_x = mouse_x;
        g_wi_adb_y = mouse_y;
        g_wi_adb_pos_valid = true;
        c89_adb_mouse_set_position(mouse_x, mouse_y);
    }
}

static bool wi_refresh_adb_position(int32_t *pending_dx, int32_t *pending_dy)
{
    int x = 0;
    int y = 0;
    int pdx = 0;
    int pdy = 0;

    if (!g_wi_adb_pos_valid) {
        wi_seed_adb_position_from_mac_mouse();
    }

    if (!c89_adb_mouse_get_position(&x, &y, &pdx, &pdy)) {
        return false;
    }

    g_wi_adb_x = x;
    g_wi_adb_y = y;
    g_wi_adb_pos_valid = true;
    if (pending_dx) {
        *pending_dx = pdx;
    }
    if (pending_dy) {
        *pending_dy = pdy;
    }
    return true;
}

static bool wi_guest_code_addr_is_plausible(uint32_t addr)
{
    return addr > 0x1000 && addr < 0x50000000u;
}

static uint32_t wi_read_u32_be(hwaddr addr, bool *ok)
{
    MemTxResult res;
    uint32_t value = address_space_ldl_be(&address_space_memory, addr,
                                          MEMTXATTRS_UNSPECIFIED, &res);
    if (ok) {
        *ok = res == MEMTX_OK;
    }
    return value;
}

static uint16_t wi_read_u16_be(hwaddr addr, bool *ok)
{
    MemTxResult res;
    uint16_t value = address_space_lduw_be(&address_space_memory, addr,
                                           MEMTXATTRS_UNSPECIFIED, &res);
    if (ok) {
        *ok = res == MEMTX_OK;
    }
    return value;
}

static uint8_t wi_read_u8(hwaddr addr, bool *ok)
{
    MemTxResult res;
    uint8_t value = address_space_ldub(&address_space_memory, addr,
                                       MEMTXATTRS_UNSPECIFIED, &res);
    if (ok) {
        *ok = res == MEMTX_OK;
    }
    return value;
}

static void wi_write_u32_be(hwaddr addr, uint32_t value)
{
    MemTxResult res;
    address_space_stl_be(&address_space_memory, addr, value,
                         MEMTXATTRS_UNSPECIFIED, &res);
}

static void wi_write_u8(hwaddr addr, uint8_t value)
{
    MemTxResult res;
    address_space_stb(&address_space_memory, addr, value,
                      MEMTXATTRS_UNSPECIFIED, &res);
}

static uint32_t wi_find_rom_rts(void)
{
    uint8_t buf[4096];
    MemTxResult res;

    if (g_wi_cursor_rts_addr) {
        return g_wi_cursor_rts_addr;
    }

    for (uint32_t off = 0; off < WI_MAC_ROM_SCAN_BYTES; off += sizeof(buf)) {
        hwaddr addr = WI_MAC_ROM_BASE + off;
        res = address_space_read(&address_space_memory, addr,
                                 MEMTXATTRS_UNSPECIFIED, buf, sizeof(buf));
        if (res != MEMTX_OK) {
            continue;
        }
        for (size_t i = 0; i + 1 < sizeof(buf); i += 2) {
            if (buf[i] == 0x4e && buf[i + 1] == 0x75) {
                g_wi_cursor_rts_addr = (uint32_t)(addr + i);
                return g_wi_cursor_rts_addr;
            }
        }
    }
    return 0;
}

static void wi_suppress_mac_software_cursor(void)
{
    bool ok = false;
    uint32_t draw_vec = wi_read_u32_be(WI_MAC_DRAW_CRSR_VECTOR, &ok);
    uint32_t erase_vec;
    uint32_t rts_addr;
    bool ok_erase = false;
    bool ok_vis = false;
    bool ok_state = false;
    uint8_t crsr_vis;
    uint16_t crsr_state;
    bool cursor_visible;

    if (!ok || !wi_guest_code_addr_is_plausible(draw_vec)) {
        return;
    }
    erase_vec = wi_read_u32_be(WI_MAC_ERASE_CRSR_VECTOR, &ok_erase);

    rts_addr = wi_find_rom_rts();
    if (!rts_addr) {
        return;
    }
    g_wi_cursor_hardware_active = true;

    /*
     * 68k_web replaces both DrawCrsr/EraseCrsr with an RTS stub and reasserts
     * the patch because Mac OS reinstalls these vectors. From this QEMU timer
     * we cannot safely execute the guest erase routine first, so use a two
     * phase version: suppress draws immediately, and suppress erases once the
     * low-memory state says no software cursor is currently painted. This keeps
     * EraseCrsr available long enough to clean up an already-drawn cursor while
     * still preventing future framebuffer cursor churn.
     */
    if (draw_vec != rts_addr) {
        wi_write_u32_be(WI_MAC_DRAW_CRSR_VECTOR, rts_addr);
    }

    crsr_vis = wi_read_u8(WI_MAC_CRSR_VIS, &ok_vis);
    crsr_state = wi_read_u16_be(WI_MAC_CRSR_STATE, &ok_state);
    cursor_visible = ok_vis && ok_state && crsr_vis != 0 &&
                     (int16_t)crsr_state > 0;
    if (ok_erase && erase_vec != rts_addr &&
        (!cursor_visible || !wi_guest_code_addr_is_plausible(erase_vec))) {
        wi_write_u32_be(WI_MAC_ERASE_CRSR_VECTOR, rts_addr);
    }

    wi_write_u8(WI_MAC_CRSR_NEW, 0);
    if (!g_wi_cursor_suppression_logged &&
        (draw_vec != rts_addr || (ok_erase && erase_vec != rts_addr))) {
        info_report("c89 wasminput: Mac software cursor suppressed "
                    "(draw%s, erase%s -> 0x%08x)",
                    draw_vec == rts_addr ? " already" : "",
                    ok_erase && erase_vec == rts_addr ? " already" :
                    (cursor_visible ? " pending-visible" : ""),
                    rts_addr);
        g_wi_cursor_suppression_logged = true;
    }
}

static void wi_poll_mouse(int32_t *ctrl)
{
    int32_t dx = wi_exchange_i32(&ctrl[WI_C_REL_DX], 0);
    int32_t dy = wi_exchange_i32(&ctrl[WI_C_REL_DY], 0);
    int32_t abs_flags = wi_exchange_i32(&ctrl[WI_C_ABS_FLAGS], 0);
    int32_t abs_x = wi_load_acq(&ctrl[WI_C_ABS_X]);
    int32_t abs_y = wi_load_acq(&ctrl[WI_C_ABS_Y]);
    int32_t abs_w = wi_load_acq(&ctrl[WI_C_ABS_WIDTH]);
    int32_t abs_h = wi_load_acq(&ctrl[WI_C_ABS_HEIGHT]);
    uint32_t buttons = (uint32_t)wi_load_acq(&ctrl[WI_C_BUTTONS]);
    int adb_buttons = 0;
    int effective_adb_buttons;
    int32_t target_dx = 0;
    int32_t target_dy = 0;
    int32_t pending_dx = 0;
    int32_t pending_dy = 0;
    bool target_pending = false;
    bool relative_motion_requested = dx != 0 || dy != 0;
    bool emit_adb_event;

    ctrl[WI_C_LAST_ABS_FLAGS] = abs_flags;
    if (relative_motion_requested) {
        g_wi_hybrid_motion_active = true;
    }

    if (buttons & 0x01) {
        adb_buttons |= MOUSE_EVENT_LBUTTON;
    }
    if (buttons & 0x02) {
        adb_buttons |= MOUSE_EVENT_MBUTTON;
    }
    if (buttons & 0x04) {
        adb_buttons |= MOUSE_EVENT_RBUTTON;
    }

    if (abs_flags) {
        wi_seed_adb_position_from_mac_mouse();
        if (abs_w > 0 && abs_x >= abs_w) {
            abs_x = abs_w - 1;
        }
        if (abs_h > 0 && abs_y >= abs_h) {
            abs_y = abs_h - 1;
        }
        if (abs_x < 0) {
            abs_x = 0;
        }
        if (abs_y < 0) {
            abs_y = 0;
        }
        g_wi_abs_x = abs_x;
        g_wi_abs_y = abs_y;
        g_wi_abs_valid = true;
        ctrl[WI_C_LAST_ABS_EVENT_X] = abs_x;
        ctrl[WI_C_LAST_ABS_EVENT_Y] = abs_y;
        ctrl[WI_C_LAST_ABS_EVENT_W] = abs_w;
        ctrl[WI_C_LAST_ABS_EVENT_H] = abs_h;
        ctrl[WI_C_MOUSE_ABS_SYNCS]++;
    }

    if (g_wi_abs_valid) {
        /*
         * Browser coordinates are the source of truth, so the Classic Mac
         * low-memory Points are updated immediately. When the JS side has asked
         * for hybrid motion, keep QEMU's ADB-relative cursor walking toward the
         * same absolute target until the guest has actually polled the packets;
         * do not clear pending deltas just because there was no new pointermove
         * in this timer tick. That keeps the visible A/UX cursor and click
         * target synchronized with the low-memory anchor.
         */
        wi_sync_mac_mouse_lowmem(g_wi_abs_x, g_wi_abs_y);
        if (g_wi_hybrid_motion_active &&
            wi_refresh_adb_position(&pending_dx, &pending_dy)) {
            target_dx = wi_clamp_adb_delta(g_wi_abs_x - g_wi_adb_x);
            target_dy = wi_clamp_adb_delta(g_wi_abs_y - g_wi_adb_y);
            target_pending = (g_wi_adb_x != g_wi_abs_x) ||
                             (g_wi_adb_y != g_wi_abs_y) ||
                             pending_dx != 0 || pending_dy != 0;
            dx = target_dx;
            dy = target_dy;
        } else {
            dx = wi_clamp_adb_delta(dx);
            dy = wi_clamp_adb_delta(dy);
            c89_adb_mouse_set_position(g_wi_abs_x, g_wi_abs_y);
            g_wi_adb_x = g_wi_abs_x;
            g_wi_adb_y = g_wi_abs_y;
            g_wi_adb_pos_valid = true;
        }
    }

    if (adb_buttons != g_wi_seen_adb_buttons) {
        wi_queue_button_transition(adb_buttons);
        g_wi_seen_adb_buttons = adb_buttons;
    }

    effective_adb_buttons = (int)g_wi_last_buttons;
    if (!g_wi_abs_valid || !target_pending) {
        int queued_buttons;

        if (wi_dequeue_button_transition(&queued_buttons)) {
            effective_adb_buttons = queued_buttons;
        }
    }

    emit_adb_event = dx || dy ||
                     effective_adb_buttons != (int)g_wi_last_buttons ||
                     (abs_flags && (!g_wi_hybrid_motion_active || !target_pending));

    if (emit_adb_event) {
        if (g_wi_abs_valid) {
            c89_adb_mouse_set_event(dx, dy, effective_adb_buttons);
            wi_sync_mac_mouse_lowmem(g_wi_abs_x, g_wi_abs_y);
        } else {
            c89_adb_mouse_event(dx, dy, effective_adb_buttons);
        }
        if (dx || dy) {
            ctrl[WI_C_LAST_MOUSE_DX] = dx;
            ctrl[WI_C_LAST_MOUSE_DY] = dy;
        }
        if (dx || dy || abs_flags) {
            ctrl[WI_C_MOUSE_EVENTS]++;
        }
        if (effective_adb_buttons != (int)g_wi_last_buttons) {
            ctrl[WI_C_BUTTON_EVENTS]++;
        }
        g_wi_last_buttons = (uint32_t)effective_adb_buttons;
    }
    wi_refresh_adb_position(NULL, NULL);
    ctrl[WI_C_LAST_ADB_BUTTONS] = effective_adb_buttons;
    ctrl[WI_C_TARGET_PENDING] = target_pending ? 1 : 0;
    wi_refresh_adb_debug(ctrl);
    wi_refresh_mac_mouse_diag(ctrl);
    ctrl[WI_C_LAST_BUTTONS] = (int32_t)g_wi_last_buttons;
}

static void wi_poll_keys(int32_t *ctrl)
{
    int32_t read = wi_load_acq(&ctrl[WI_C_KEY_READ]);
    int32_t write = wi_load_acq(&ctrl[WI_C_KEY_WRITE]);
    int guard = 0;

    while (read != write && guard++ < C89_WI_KEY_EVENTS_PER_POLL) {
        int32_t *slot = g_wi_shared.keys[(uint32_t)read % WI_KEY_SLOTS];
        int32_t qcode = wi_load_acq(&slot[0]);
        int32_t down = wi_load_acq(&slot[1]);
        int32_t adb = wi_load_acq(&slot[2]);

        if (adb >= 0 && adb <= 0x7f) {
            c89_adb_kbd_put_key(adb, down != 0);
            ctrl[WI_C_KEY_EVENTS]++;
            ctrl[WI_C_LAST_QCODE] = qcode;
            ctrl[WI_C_LAST_ADB] = adb;
        }
        read++;
        wi_store_rel(&ctrl[WI_C_KEY_READ], read);
    }
}

static int wi_clamp_cursor_hotspot(int value)
{
    if (value < 0) {
        return 0;
    }
    if (value > 15) {
        return 15;
    }
    return value;
}

static bool wi_cursor_has_content(const uint8_t *cursor)
{
    int data_content = 0;
    int mask_content = 0;

    for (int i = 0; i < 32; i++) {
        if (cursor[i]) {
            data_content++;
        }
        if (cursor[32 + i]) {
            mask_content++;
        }
    }
    return data_content >= 4 || mask_content >= 4;
}

static void wi_poll_cursor(int32_t *ctrl)
{
    uint8_t record[68];
    uint8_t cursor[WI_CURSOR_BYTES];
    MemTxResult res;
    int hot_y;
    int hot_x;
    bool suppress_requested = wi_load_acq(&ctrl[WI_C_CURSOR_SUPPRESS]) != 0;
    bool valid;
    bool changed;

    /*
     * Classic Mac low memory TheCrsr:
     *   0x844 + 0..31  data bitmap
     *   0x844 + 32..63 mask bitmap
     *   0x844 + 64..65 hotspot.v
     *   0x844 + 66..67 hotspot.h
     *
     * Export the cursor and suppress the classic Mac software draw path. The
     * page turns these bytes into the host CSS cursor.
     */
    res = address_space_read(&address_space_memory, WI_MAC_THECRSR,
                             MEMTXATTRS_UNSPECIFIED, record, sizeof(record));
    if (res != MEMTX_OK) {
        valid = false;
        hot_x = 1;
        hot_y = 1;
        memset(cursor, 0, sizeof(cursor));
    } else {
        memcpy(cursor, record, WI_CURSOR_BYTES);
        hot_y = (int16_t)((record[64] << 8) | record[65]);
        hot_x = (int16_t)((record[66] << 8) | record[67]);
        hot_y = wi_clamp_cursor_hotspot(hot_y);
        hot_x = wi_clamp_cursor_hotspot(hot_x);
        valid = wi_cursor_has_content(cursor);
        if (suppress_requested && (valid || g_wi_cursor_hardware_active)) {
            bool was_active = g_wi_cursor_hardware_active;
            wi_suppress_mac_software_cursor();
            if (!was_active && g_wi_cursor_hardware_active) {
                ctrl[WI_C_CURSOR_SUPPRESS_TRANSITIONS]++;
            }
        }
    }
    ctrl[WI_C_CURSOR_SUPPRESS_ACTIVE] = g_wi_cursor_hardware_active ? 1 : 0;

    changed = valid != g_wi_last_cursor_valid ||
              hot_x != g_wi_last_cursor_hot_x ||
              hot_y != g_wi_last_cursor_hot_y ||
              memcmp(cursor, g_wi_last_cursor, WI_CURSOR_BYTES) != 0;
    if (!changed) {
        return;
    }

    memcpy(g_wi_shared.cursor, cursor, WI_CURSOR_BYTES);
    memcpy(g_wi_last_cursor, cursor, WI_CURSOR_BYTES);
    g_wi_last_cursor_hot_x = hot_x;
    g_wi_last_cursor_hot_y = hot_y;
    g_wi_last_cursor_valid = valid;
    ctrl[WI_C_CURSOR_HOT_X] = hot_x;
    ctrl[WI_C_CURSOR_HOT_Y] = hot_y;
    ctrl[WI_C_CURSOR_VALID] = valid ? 1 : 0;
    wi_store_rel(&ctrl[WI_C_CURSOR_SEQ], ctrl[WI_C_CURSOR_SEQ] + 1);
}

static void wi_poll(void *opaque)
{
    int32_t *ctrl = g_wi_shared.ctrl;
    (void)opaque;

    if (wi_load_acq(&ctrl[WI_C_READY])) {
        wi_poll_cursor(ctrl);
        wi_poll_mouse(ctrl);
        wi_poll_keys(ctrl);
    }
    timer_mod(g_wi_timer,
              qemu_clock_get_ms(QEMU_CLOCK_REALTIME) + C89_WI_POLL_MS);
}

static void wi_reset_shared(void)
{
    int32_t *ctrl = g_wi_shared.ctrl;

    memset(&g_wi_shared, 0, sizeof(g_wi_shared));
    g_wi_last_buttons = 0;
    memset(g_wi_last_cursor, 0, sizeof(g_wi_last_cursor));
    g_wi_last_cursor_hot_x = 0;
    g_wi_last_cursor_hot_y = 0;
    g_wi_last_cursor_valid = false;
    g_wi_cursor_rts_addr = 0;
    g_wi_cursor_hardware_active = false;
    g_wi_cursor_suppression_logged = false;
    g_wi_abs_valid = false;
    g_wi_abs_x = 0;
    g_wi_abs_y = 0;
    g_wi_last_sync_x = 0;
    g_wi_last_sync_y = 0;
    g_wi_hybrid_motion_active = false;
    g_wi_adb_pos_valid = false;
    g_wi_adb_x = 0;
    g_wi_adb_y = 0;
    g_wi_seen_adb_buttons = 0;
    memset(g_wi_button_queue, 0, sizeof(g_wi_button_queue));
    g_wi_button_queue_read = 0;
    g_wi_button_queue_write = 0;
    ctrl[WI_C_KEY_SLOTS] = WI_KEY_SLOTS;
    ctrl[WI_C_KEY_STRIDE] = WI_KEY_STRIDE;
    ctrl[WI_C_POLL_MS] = C89_WI_POLL_MS;
    ctrl[WI_C_CURSOR_OFFSET] = (int32_t)offsetof(WasmInputShared, cursor);
    ctrl[WI_C_CURSOR_BYTES] = WI_CURSOR_BYTES;
    ctrl[WI_C_VERSION] = WI_VERSION;
    wi_store_rel(&ctrl[WI_C_MAGIC], (int32_t)WI_MAGIC);
}

static void wi_machine_init_done(Notifier *notifier, void *data)
{
    (void)notifier;
    (void)data;

    wi_reset_shared();
    g_wi_timer = timer_new_ms(QEMU_CLOCK_REALTIME, wi_poll, NULL);
    timer_mod(g_wi_timer,
              qemu_clock_get_ms(QEMU_CLOCK_REALTIME) + C89_WI_POLL_MS);
    wi_store_rel(&g_wi_shared.ctrl[WI_C_READY], 1);
    info_report("c89 wasminput backend ready (shared block at %u, "
                "%d key slots, %dms poll)",
                c89_input_shared_ptr(), WI_KEY_SLOTS, C89_WI_POLL_MS);
}

static void wi_register(void)
{
    g_wi_machine_done.notify = wi_machine_init_done;
    qemu_add_machine_init_done_notifier(&g_wi_machine_done);
}

type_init(wi_register);
