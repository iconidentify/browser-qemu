/*
 * Page-side shared-memory input bridge for browser-qemu.
 *
 * This mirrors the 68k_web input shape: browser events are translated once,
 * written into a compact shared block, and consumed by the emulator on its own
 * timer. It avoids HMP monitor text commands for interactive input.
 */
(function (root) {
  "use strict";

  var WI_MAGIC = 0xc8917001;
  var WI_NCTRL = 32;
  var C_MAGIC = 0, C_READY = 1, C_VERSION = 2, C_REL_DX = 3, C_REL_DY = 4,
      C_ABS_X = 5, C_ABS_Y = 6, C_ABS_FLAGS = 7, C_BUTTONS = 8,
      C_KEY_WRITE = 9, C_KEY_READ = 10, C_KEY_DROP = 11,
      C_KEY_SLOTS = 12, C_KEY_STRIDE = 13, C_POLL_MS = 14,
      C_MOUSE_EVENTS = 15, C_KEY_EVENTS = 16, C_BUTTON_EVENTS = 17,
      C_LAST_QCODE = 18, C_LAST_ADB = 19, C_LAST_BUTTONS = 20,
      C_ABS_WIDTH = 21, C_ABS_HEIGHT = 22, C_CURSOR_SEQ = 23,
      C_CURSOR_HOT_X = 24, C_CURSOR_HOT_Y = 25, C_CURSOR_VALID = 26,
      C_CURSOR_OFFSET = 27, C_CURSOR_BYTES = 28, C_MOUSE_ABS_SYNCS = 29;

  var MOD_SHIFT = 0x0200;
  var MOD_CAPS = 0x0002;
  var MOD_CTRL = 0x1000;
  var MOD_ALT = 0x0800;
  var MOD_CMD = 0x0100;
  var BUTTON_RELEASE_HOLD_MS = 60;

  var qkeyNames = [
    "unmapped", "shift", "shift_r", "alt", "alt_r", "ctrl", "ctrl_r",
    "menu", "esc", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
    "minus", "equal", "backspace", "tab", "q", "w", "e", "r", "t", "y",
    "u", "i", "o", "p", "bracket_left", "bracket_right", "ret", "a", "s",
    "d", "f", "g", "h", "j", "k", "l", "semicolon", "apostrophe",
    "grave_accent", "backslash", "z", "x", "c", "v", "b", "n", "m",
    "comma", "dot", "slash", "asterisk", "spc", "caps_lock", "f1", "f2",
    "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "num_lock",
    "scroll_lock", "kp_divide", "kp_multiply", "kp_subtract", "kp_add",
    "kp_enter", "kp_decimal", "sysrq", "kp_0", "kp_1", "kp_2", "kp_3",
    "kp_4", "kp_5", "kp_6", "kp_7", "kp_8", "kp_9", "less", "f11",
    "f12", "print", "home", "pgup", "pgdn", "end", "left", "up", "down",
    "right", "insert", "delete", "stop", "again", "props", "undo",
    "front", "copy", "open", "paste", "find", "cut", "lf", "help",
    "meta_l", "meta_r", "compose", "pause", "ro", "hiragana", "henkan",
    "yen", "muhenkan", "katakanahiragana", "kp_comma", "kp_equals",
    "power", "sleep", "wake", "audionext", "audioprev", "audiostop",
    "audioplay", "audiomute", "volumeup", "volumedown", "mediaselect",
    "mail", "calculator", "computer", "ac_home", "ac_back", "ac_forward",
    "ac_refresh", "ac_bookmarks", "lang1", "lang2", "f13", "f14", "f15",
    "f16", "f17", "f18", "f19", "f20", "f21", "f22", "f23", "f24",
  ];
  var QK = {};
  for (var i = 0; i < qkeyNames.length; i++) QK[qkeyNames[i]] = i;

  var codeToQKey = {
    Escape: "esc",
    Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5",
    Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9", Digit0: "0",
    Minus: "minus", Equal: "equal", Backspace: "backspace", Tab: "tab",
    KeyQ: "q", KeyW: "w", KeyE: "e", KeyR: "r", KeyT: "t", KeyY: "y",
    KeyU: "u", KeyI: "i", KeyO: "o", KeyP: "p",
    BracketLeft: "bracket_left", BracketRight: "bracket_right",
    Enter: "ret", NumpadEnter: "kp_enter",
    KeyA: "a", KeyS: "s", KeyD: "d", KeyF: "f", KeyG: "g", KeyH: "h",
    KeyJ: "j", KeyK: "k", KeyL: "l",
    Semicolon: "semicolon", Quote: "apostrophe", Backquote: "grave_accent",
    Backslash: "backslash",
    KeyZ: "z", KeyX: "x", KeyC: "c", KeyV: "v", KeyB: "b", KeyN: "n",
    KeyM: "m", Comma: "comma", Period: "dot", Slash: "slash",
    Space: "spc", CapsLock: "caps_lock",
    ShiftLeft: "shift", ShiftRight: "shift_r",
    ControlLeft: "ctrl", ControlRight: "ctrl_r",
    AltLeft: "alt", AltRight: "alt_r",
    MetaLeft: "meta_l", MetaRight: "meta_r",
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
    Insert: "insert", Delete: "delete", Home: "home", End: "end",
    PageUp: "pgup", PageDown: "pgdn",
    Numpad0: "kp_0", Numpad1: "kp_1", Numpad2: "kp_2", Numpad3: "kp_3",
    Numpad4: "kp_4", Numpad5: "kp_5", Numpad6: "kp_6", Numpad7: "kp_7",
    Numpad8: "kp_8", Numpad9: "kp_9",
    NumpadDecimal: "kp_decimal", NumpadDivide: "kp_divide",
    NumpadMultiply: "kp_multiply", NumpadSubtract: "kp_subtract",
    NumpadAdd: "kp_add", NumpadEqual: "kp_equals",
    F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
    F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",
    F13: "f13", F14: "f14", F15: "f15", F16: "f16", F17: "f17",
    F18: "f18", F19: "f19", F20: "f20", F21: "f21", F22: "f22",
    F23: "f23", F24: "f24",
  };

  var adbKeyCodes = {
    KeyA: 0x00, KeyS: 0x01, KeyD: 0x02, KeyF: 0x03,
    KeyH: 0x04, KeyG: 0x05, KeyZ: 0x06, KeyX: 0x07,
    KeyC: 0x08, KeyV: 0x09, KeyB: 0x0b, KeyQ: 0x0c,
    KeyW: 0x0d, KeyE: 0x0e, KeyR: 0x0f, KeyY: 0x10,
    KeyT: 0x11, Digit1: 0x12, Digit2: 0x13, Digit3: 0x14,
    Digit4: 0x15, Digit6: 0x16, Digit5: 0x17, Equal: 0x18,
    Digit9: 0x19, Digit7: 0x1a, Minus: 0x1b, Digit8: 0x1c,
    Digit0: 0x1d, BracketRight: 0x1e, KeyO: 0x1f, KeyU: 0x20,
    BracketLeft: 0x21, KeyI: 0x22, KeyP: 0x23, Enter: 0x24,
    KeyL: 0x25, KeyJ: 0x26, Quote: 0x27, KeyK: 0x28,
    Semicolon: 0x29, Backslash: 0x2a, Comma: 0x2b, Slash: 0x2c,
    KeyN: 0x2d, KeyM: 0x2e, Period: 0x2f, Tab: 0x30,
    Space: 0x31, Backquote: 0x32, Backspace: 0x33, Escape: 0x35,
    ControlLeft: 0x36, MetaLeft: 0x37, ShiftLeft: 0x38,
    CapsLock: 0x39, AltLeft: 0x3a, ArrowLeft: 0x3b,
    ArrowRight: 0x3c, ArrowDown: 0x3d, ArrowUp: 0x3e,
    NumpadDecimal: 0x41, NumpadMultiply: 0x43, NumpadAdd: 0x45,
    NumLock: 0x47, NumpadDivide: 0x4b, NumpadEnter: 0x4c,
    NumpadSubtract: 0x4e, NumpadEqual: 0x51, Numpad0: 0x52,
    Numpad1: 0x53, Numpad2: 0x54, Numpad3: 0x55, Numpad4: 0x56,
    Numpad5: 0x57, Numpad6: 0x58, Numpad7: 0x59, Numpad8: 0x5b,
    Numpad9: 0x5c, F5: 0x60, F6: 0x61, F7: 0x62, F3: 0x63,
    F8: 0x64, F9: 0x65, F11: 0x67, F10: 0x6d, F12: 0x6f,
    Help: 0x72, Home: 0x73, PageUp: 0x74, Delete: 0x75,
    F4: 0x76, End: 0x77, F2: 0x78, PageDown: 0x79, F1: 0x7a,
    ShiftRight: 0x7b, AltRight: 0x7c, ControlRight: 0x7d,
  };
  var modifierCodes = {
    ShiftLeft: true, ShiftRight: true,
    ControlLeft: true, ControlRight: true,
    AltLeft: true, AltRight: true,
    MetaLeft: true, MetaRight: true,
    CapsLock: true,
  };

  function clampInt(value, min, max) {
    value = Math.trunc(Number(value) || 0);
    return Math.max(min, Math.min(max, value));
  }

  function cssPixelNumber(value) {
    var n = Number.parseFloat(value || "0");
    return Number.isFinite(n) ? n : 0;
  }

  function canvasContentBox(canvas) {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var style = root.getComputedStyle ? root.getComputedStyle(canvas) : null;
    var borderLeft = style ? cssPixelNumber(style.borderLeftWidth) : 0;
    var borderRight = style ? cssPixelNumber(style.borderRightWidth) : 0;
    var borderTop = style ? cssPixelNumber(style.borderTopWidth) : 0;
    var borderBottom = style ? cssPixelNumber(style.borderBottomWidth) : 0;
    var width = Math.max(1, rect.width - borderLeft - borderRight);
    var height = Math.max(1, rect.height - borderTop - borderBottom);
    return {
      left: rect.left + borderLeft,
      top: rect.top + borderTop,
      width: width,
      height: height,
    };
  }

  function buttonMaskFromEvent(event) {
    var buttons = event.buttons || 0;
    var mask = 0;
    if (buttons & 1) mask |= 1;
    if (buttons & 4) mask |= 2;
    if (buttons & 2) mask |= 4;
    return mask;
  }

  function modifierMask(event, capsLockState) {
    var mods = 0;
    if (event.shiftKey) mods |= MOD_SHIFT;
    if (event.ctrlKey) mods |= MOD_CTRL;
    if (event.altKey) mods |= MOD_ALT;
    if (event.metaKey) mods |= MOD_CMD;
    if (capsLockState) mods |= MOD_CAPS;
    return mods;
  }

  function qcodeForEvent(event) {
    var name = codeToQKey[event.code || ""];
    return name ? (QK[name] || 0) : 0;
  }

  function canvasScale(canvas) {
    var rect = canvasContentBox(canvas);
    if (!rect) return null;
    return {
      rect: rect,
      x: canvas.width / rect.width,
      y: canvas.height / rect.height,
    };
  }

  function movementForEvent(canvas, event) {
    var scale = canvasScale(canvas);
    if (!scale) return null;
    return {
      dx: clampInt((event.movementX || 0) * scale.x, -2048, 2048),
      dy: clampInt((event.movementY || 0) * scale.y, -2048, 2048),
    };
  }

  function pointForEvent(canvas, event, lastPoint) {
    var scale = canvasScale(canvas);
    if (!scale) return null;
    if (root.document && root.document.pointerLockElement === canvas && lastPoint) {
      var movement = movementForEvent(canvas, event) || { dx: 0, dy: 0 };
      return {
        x: clampInt(lastPoint.x + movement.dx, 0, canvas.width - 1),
        y: clampInt(lastPoint.y + movement.dy, 0, canvas.height - 1),
      };
    }
    return {
      x: clampInt((event.clientX - scale.rect.left) * scale.x, 0, canvas.width - 1),
      y: clampInt((event.clientY - scale.rect.top) * scale.y, 0, canvas.height - 1),
    };
  }

  root.createAuxSharedInputBridge = function (options) {
    var module = options.module;
    var canvas = options.canvas;
    var log = options.log || function () {};

    var base = 0, ctrlBase = 0, keyBase = 0;
    var ctrl = null;
    var heap8 = null;
    var keySlots = 0;
    var keyStride = 0;
    var cursorSeq = 0;
    var lastPoint = null;
    var lastButtonMask = 0;
    var buttonReleaseTimer = 0;
    var capsLockState = false;
    var pressedCodes = new Set();
    var ready = false;
    var stats = { keys: 0, keyDrops: 0, mouseMoves: 0, buttons: 0 };

    function refreshViews() {
      if (ctrl !== module.HEAP32) {
        ctrl = module.HEAP32;
      }
      if (heap8 !== module.HEAPU8) {
        heap8 = module.HEAPU8;
      }
    }

    function locate() {
      if (typeof module.c89InputSharedPtr !== "function") {
        throw new Error("wasminput export missing (rebuild QEMU with ui/wasminput.c)");
      }
      base = module.c89InputSharedPtr() >>> 0;
      if (!base) throw new Error("wasminput shared block address is 0");
      refreshViews();
      ctrlBase = base >> 2;
      var magic = Atomics.load(ctrl, ctrlBase + C_MAGIC) >>> 0;
      if (magic !== WI_MAGIC) {
        throw new Error("wasminput magic mismatch 0x" + magic.toString(16) + " (backend not ready)");
      }
      if (!Atomics.load(ctrl, ctrlBase + C_READY)) {
        throw new Error("wasminput backend not ready");
      }
      keySlots = Atomics.load(ctrl, ctrlBase + C_KEY_SLOTS);
      keyStride = Atomics.load(ctrl, ctrlBase + C_KEY_STRIDE);
      keyBase = (base + WI_NCTRL * 4) >> 2;
      ready = keySlots > 0 && keyStride >= 4;
      if (!ready) throw new Error("wasminput invalid key ring layout");
      Atomics.store(ctrl, ctrlBase + C_ABS_WIDTH, canvas.width);
      Atomics.store(ctrl, ctrlBase + C_ABS_HEIGHT, canvas.height);
    }

    function queueKey(qcode, down, adb, mods) {
      if (!ready || !qcode) return false;
      refreshViews();
      var w = Atomics.load(ctrl, ctrlBase + C_KEY_WRITE);
      var r = Atomics.load(ctrl, ctrlBase + C_KEY_READ);
      if (((w - r) >>> 0) >= keySlots) {
        Atomics.add(ctrl, ctrlBase + C_KEY_DROP, 1);
        stats.keyDrops++;
        return false;
      }
      var off = keyBase + ((w >>> 0) % keySlots) * keyStride;
      Atomics.store(ctrl, off, qcode | 0);
      Atomics.store(ctrl, off + 1, down ? 1 : 0);
      Atomics.store(ctrl, off + 2, adb == null ? -1 : adb);
      Atomics.store(ctrl, off + 3, mods | 0);
      Atomics.store(ctrl, ctrlBase + C_KEY_WRITE, (w + 1) | 0);
      stats.keys++;
      return true;
    }

    function releaseNonModifierKeys() {
      pressedCodes.forEach(function (code) {
        if (modifierCodes[code]) return;
        releaseCode(code, 0);
      });
    }

    function writePoint(point, event) {
      if (!ready || !point) return;
      refreshViews();
      Atomics.store(ctrl, ctrlBase + C_ABS_X, point.x);
      Atomics.store(ctrl, ctrlBase + C_ABS_Y, point.y);
      Atomics.store(ctrl, ctrlBase + C_ABS_WIDTH, canvas.width);
      Atomics.store(ctrl, ctrlBase + C_ABS_HEIGHT, canvas.height);
      Atomics.store(ctrl, ctrlBase + C_ABS_FLAGS, 1);

      var movement = event ? movementForEvent(canvas, event) : null;
      if (movement && (movement.dx || movement.dy)) {
        Atomics.add(ctrl, ctrlBase + C_REL_DX, movement.dx);
        Atomics.add(ctrl, ctrlBase + C_REL_DY, movement.dy);
        stats.mouseMoves++;
      } else if (lastPoint) {
        Atomics.add(ctrl, ctrlBase + C_REL_DX, clampInt(point.x - lastPoint.x, -2048, 2048));
        Atomics.add(ctrl, ctrlBase + C_REL_DY, clampInt(point.y - lastPoint.y, -2048, 2048));
        stats.mouseMoves++;
      }
      lastPoint = point;
    }

    function releaseCode(code, mods) {
      var qcode = QK[codeToQKey[code] || ""];
      if (qcode) queueKey(qcode, false, adbKeyCodes[code], mods || 0);
      pressedCodes.delete(code);
    }

    function writeButtonMask(mask) {
      if (!ready) return;
      refreshViews();
      Atomics.store(ctrl, ctrlBase + C_BUTTONS, mask);
      lastButtonMask = mask;
      stats.buttons++;
    }

    function queueButtonMask(mask) {
      if (mask === lastButtonMask) return;
      if (mask) {
        clearButtonReleaseTimer();
        writeButtonMask(mask);
        return;
      }
      if (lastButtonMask && !buttonReleaseTimer) {
        buttonReleaseTimer = root.setTimeout(function () {
          buttonReleaseTimer = 0;
          writeButtonMask(0);
        }, BUTTON_RELEASE_HOLD_MS);
      }
    }

    function clearButtonReleaseTimer() {
      if (buttonReleaseTimer) {
        root.clearTimeout(buttonReleaseTimer);
        buttonReleaseTimer = 0;
      }
    }

    return {
      start: function () {
        locate();
        log("shared input bridge ready: " + keySlots + " key slots, poll " +
          Atomics.load(ctrl, ctrlBase + C_POLL_MS) + "ms");
      },
      stop: function () {
        ready = false;
        lastPoint = null;
        clearButtonReleaseTimer();
        lastButtonMask = 0;
        pressedCodes.clear();
      },
      isReady: function () {
        return ready;
      },
      keyEvent: function (event, down) {
        var qcode = qcodeForEvent(event);
        if (!qcode) return false;
        if (typeof event.getModifierState === "function") {
          capsLockState = event.getModifierState("CapsLock");
        }
        if (event.code === "CapsLock") {
          if (!down) return true;
          pressedCodes.add(event.code);
          if (queueKey(qcode, true, adbKeyCodes[event.code], modifierMask(event, capsLockState))) {
            root.setTimeout(function () {
              queueKey(qcode, false, adbKeyCodes[event.code], modifierMask(event, capsLockState));
              pressedCodes.delete(event.code);
            }, 50);
          }
          return true;
        }
        var isModifier = Boolean(modifierCodes[event.code]);
        if (down) {
          if (event.repeat || pressedCodes.has(event.code)) return true;
          pressedCodes.add(event.code);
          return queueKey(qcode, true, adbKeyCodes[event.code], modifierMask(event, capsLockState));
        } else {
          if (!isModifier && !pressedCodes.has(event.code)) return true;
          releaseCode(event.code, modifierMask(event, capsLockState));
          if (event.code === "MetaLeft" || event.code === "MetaRight") {
            releaseNonModifierKeys();
          }
          return true;
        }
      },
      releaseAll: function () {
        pressedCodes.forEach(function (code) {
          releaseCode(code, 0);
        });
        pressedCodes.clear();
      },
      mouseEvent: function (event) {
        var point = pointForEvent(canvas, event, lastPoint);
        writePoint(point, event);
        queueButtonMask(buttonMaskFromEvent(event));
        return point;
      },
      testKey: function (code, down) {
        var qcode = QK[codeToQKey[code] || ""];
        if (!qcode) return false;
        return queueKey(qcode, Boolean(down), adbKeyCodes[code], 0);
      },
      testPointer: function (x, y, buttons) {
        var point = {
          x: clampInt(x, 0, Math.max(0, canvas.width - 1)),
          y: clampInt(y, 0, Math.max(0, canvas.height - 1)),
        };
        writePoint(point, null);
        queueButtonMask(clampInt(buttons, 0, 7));
        return point;
      },
      releaseMouse: function () {
        if (!ready) return;
        clearButtonReleaseTimer();
        writeButtonMask(0);
        lastPoint = null;
      },
      readCursor: function () {
        var seq, offset, bytes, cursorBase;
        if (!ready) return null;
        refreshViews();
        seq = Atomics.load(ctrl, ctrlBase + C_CURSOR_SEQ);
        bytes = Atomics.load(ctrl, ctrlBase + C_CURSOR_BYTES);
        offset = Atomics.load(ctrl, ctrlBase + C_CURSOR_OFFSET);
        if (!seq || seq === cursorSeq || bytes !== 64 || !offset) return null;
        cursorSeq = seq;
        cursorBase = base + offset;
        if (!heap8 || cursorBase + bytes > heap8.length) return null;
        return {
          seq: seq,
          valid: Boolean(Atomics.load(ctrl, ctrlBase + C_CURSOR_VALID)),
          hotspotX: Atomics.load(ctrl, ctrlBase + C_CURSOR_HOT_X),
          hotspotY: Atomics.load(ctrl, ctrlBase + C_CURSOR_HOT_Y),
          bytes: heap8.slice(cursorBase, cursorBase + bytes),
        };
      },
      stats: function () {
        refreshViews();
        return {
          keys: stats.keys,
          keyDrops: stats.keyDrops + (ready ? Atomics.load(ctrl, ctrlBase + C_KEY_DROP) : 0),
          mouseMoves: stats.mouseMoves,
          buttons: stats.buttons,
          backendKeys: ready ? Atomics.load(ctrl, ctrlBase + C_KEY_EVENTS) : 0,
          backendMouse: ready ? Atomics.load(ctrl, ctrlBase + C_MOUSE_EVENTS) : 0,
          backendButtons: ready ? Atomics.load(ctrl, ctrlBase + C_BUTTON_EVENTS) : 0,
          lastQcode: ready ? Atomics.load(ctrl, ctrlBase + C_LAST_QCODE) : 0,
          lastAdb: ready ? Atomics.load(ctrl, ctrlBase + C_LAST_ADB) : -1,
          lastButtons: ready ? Atomics.load(ctrl, ctrlBase + C_LAST_BUTTONS) : 0,
          absX: ready ? Atomics.load(ctrl, ctrlBase + C_ABS_X) : 0,
          absY: ready ? Atomics.load(ctrl, ctrlBase + C_ABS_Y) : 0,
          absWidth: ready ? Atomics.load(ctrl, ctrlBase + C_ABS_WIDTH) : 0,
          absHeight: ready ? Atomics.load(ctrl, ctrlBase + C_ABS_HEIGHT) : 0,
          frontendButtons: ready ? Atomics.load(ctrl, ctrlBase + C_BUTTONS) : 0,
          version: ready ? Atomics.load(ctrl, ctrlBase + C_VERSION) : 0,
          cursorSeq: ready ? Atomics.load(ctrl, ctrlBase + C_CURSOR_SEQ) : 0,
          cursorValid: ready ? Boolean(Atomics.load(ctrl, ctrlBase + C_CURSOR_VALID)) : false,
          cursorHotspotX: ready ? Atomics.load(ctrl, ctrlBase + C_CURSOR_HOT_X) : 0,
          cursorHotspotY: ready ? Atomics.load(ctrl, ctrlBase + C_CURSOR_HOT_Y) : 0,
          mouseAbsSyncs: ready ? Atomics.load(ctrl, ctrlBase + C_MOUSE_ABS_SYNCS) : 0,
          buttonReleaseHoldMs: BUTTON_RELEASE_HOLD_MS,
        };
      },
    };
  };
})(typeof window !== "undefined" ? window : globalThis);
