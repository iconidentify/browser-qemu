/**
 * AutomationBridge - Connects to the relay's /automation WebSocket endpoint
 * and handles commands from the MCP server (screenshot, click, type, etc.).
 *
 * This is the browser-side half of the automation pipeline:
 *   MCP Server -> Go Relay -> this bridge -> emulator input/screen
 */

import { createQueuedBufferWriter, type QueuedInputBufferWriter } from '../input/QueuedInputBufferWriter';
import { ADB_KEY_CODES, CHAR_TO_KEY_CODE, Modifiers, InputBufferAddresses } from '../input/constants';

interface AutomationCommand {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface AutomationBridgeConfig {
  canvas: HTMLCanvasElement;
  inputBuffer: Int32Array;
  relayUrl?: string;
}

export class AutomationBridge {
  private ws: WebSocket | null = null;
  private writer: QueuedInputBufferWriter;
  private inputBuffer: Int32Array;
  private canvas: HTMLCanvasElement;
  private relayUrl: string;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorX = 0;
  private cursorY = 0;

  constructor(config: AutomationBridgeConfig) {
    this.canvas = config.canvas;
    this.inputBuffer = config.inputBuffer;
    this.writer = createQueuedBufferWriter(config.inputBuffer);

    // Build WS URL from current page location (goes through Vite proxy)
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.relayUrl = config.relayUrl || `${proto}//${window.location.host}/automation`;

    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;

    try {
      this.ws = new WebSocket(this.relayUrl);

      this.ws.onopen = () => {
        console.log('[AutomationBridge] Connected to relay');
        this.ws!.send(JSON.stringify({ type: 'register', role: 'browser' }));
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'peer_connected') {
            console.log('[AutomationBridge] MCP server connected');
            return;
          }
          if (msg.type === 'peer_disconnected') {
            console.log('[AutomationBridge] MCP server disconnected');
            return;
          }
          this.handleCommand(msg);
        } catch (e) {
          console.error('[AutomationBridge] Failed to parse message:', e);
        }
      };

      this.ws.onclose = () => {
        console.log('[AutomationBridge] Disconnected from relay');
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendResult(id: string, data: unknown = null): void {
    this.send({ id, type: 'result', data });
  }

  private sendError(id: string, message: string): void {
    this.send({ id, type: 'error', message });
  }

  private async handleCommand(cmd: AutomationCommand): Promise<void> {
    try {
      switch (cmd.type) {
        case 'screenshot':
          this.handleScreenshot(cmd);
          break;
        case 'mouse_move':
          this.handleMouseMove(cmd);
          break;
        case 'mouse_click':
          await this.handleMouseClick(cmd);
          break;
        case 'type_text':
          await this.handleTypeText(cmd);
          break;
        case 'key_press':
          await this.handleKeyPress(cmd);
          break;
        case 'key_combo':
          await this.handleKeyCombo(cmd);
          break;
        case 'mouse_drag':
          await this.handleMouseDrag(cmd);
          break;
        case 'screenshot_region':
          this.handleScreenshotRegion(cmd);
          break;
        case 'wait':
          await this.handleWait(cmd);
          break;
        default:
          this.sendError(cmd.id, `Unknown command: ${cmd.type}`);
      }
    } catch (e) {
      this.sendError(cmd.id, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Draw coordinate overlay onto a canvas context.
   * Includes rulers, grid lines, and cursor crosshair.
   */
  private drawOverlay(
    ctx: CanvasRenderingContext2D,
    screenW: number,
    screenH: number,
    marginLeft: number,
    marginTop: number,
    gridSpacing: number,
  ): void {
    // Rulers
    ctx.fillStyle = '#ccc';
    ctx.font = '10px monospace';

    // X-axis labels along top
    ctx.textAlign = 'center';
    for (let x = 0; x <= screenW; x += gridSpacing) {
      const sx = marginLeft + x;
      ctx.fillText(String(x), sx, 11);
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, 13);
      ctx.lineTo(sx, marginTop);
      ctx.stroke();
    }

    // Y-axis labels along left
    ctx.textAlign = 'right';
    for (let y = 0; y <= screenH; y += gridSpacing) {
      const sy = marginTop + y;
      ctx.fillText(String(y), marginLeft - 3, sy + 4);
      ctx.strokeStyle = '#888';
      ctx.beginPath();
      ctx.moveTo(marginLeft - 2, sy);
      ctx.lineTo(marginLeft, sy);
      ctx.stroke();
    }

    // Grid lines over the screen area
    ctx.strokeStyle = 'rgba(255, 255, 0, 0.15)';
    ctx.lineWidth = 1;
    for (let x = gridSpacing; x < screenW; x += gridSpacing) {
      ctx.beginPath();
      ctx.moveTo(marginLeft + x, marginTop);
      ctx.lineTo(marginLeft + x, marginTop + screenH);
      ctx.stroke();
    }
    for (let y = gridSpacing; y < screenH; y += gridSpacing) {
      ctx.beginPath();
      ctx.moveTo(marginLeft, marginTop + y);
      ctx.lineTo(marginLeft + screenW, marginTop + y);
      ctx.stroke();
    }

    // Crosshair at current cursor position
    const cx = marginLeft + this.cursorX;
    const cy = marginTop + this.cursorY;
    const size = 12;
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - size, cy);
    ctx.lineTo(cx + size, cy);
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx, cy + size);
    ctx.stroke();
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - size, cy);
    ctx.lineTo(cx + size, cy);
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx, cy + size);
    ctx.stroke();
  }

  private handleScreenshot(cmd: AutomationCommand): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const marginLeft = 30;
    const marginTop = 16;

    const offscreen = document.createElement('canvas');
    offscreen.width = w + marginLeft;
    offscreen.height = h + marginTop;
    const ctx = offscreen.getContext('2d')!;

    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, offscreen.width, offscreen.height);
    ctx.drawImage(this.canvas, marginLeft, marginTop);
    this.drawOverlay(ctx, w, h, marginLeft, marginTop, 100);

    const dataUrl = offscreen.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    this.sendResult(cmd.id, {
      image: base64,
      width: w,
      height: h,
    });
  }

  /**
   * Crop a region of the screen and return it at 2x scale with a dense
   * coordinate grid. Used for two-step targeting: first take a full screenshot
   * to find the rough area, then crop that region for precise targeting.
   */
  private handleScreenshotRegion(cmd: AutomationCommand): void {
    const rx = cmd.x as number;
    const ry = cmd.y as number;
    const rw = cmd.width as number;
    const rh = cmd.height as number;

    if (rw <= 0 || rh <= 0) {
      this.sendError(cmd.id, 'width and height must be positive');
      return;
    }

    // Clamp to screen bounds
    const sx = Math.max(0, Math.min(rx, this.canvas.width));
    const sy = Math.max(0, Math.min(ry, this.canvas.height));
    const sw = Math.min(rw, this.canvas.width - sx);
    const sh = Math.min(rh, this.canvas.height - sy);

    // Render at 2x scale for clarity
    const scale = 2;
    const marginLeft = 36;
    const marginTop = 18;
    const scaledW = sw * scale;
    const scaledH = sh * scale;

    const offscreen = document.createElement('canvas');
    offscreen.width = scaledW + marginLeft;
    offscreen.height = scaledH + marginTop;
    const ctx = offscreen.getContext('2d')!;

    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, offscreen.width, offscreen.height);

    // Draw cropped region scaled up
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, sx, sy, sw, sh, marginLeft, marginTop, scaledW, scaledH);

    // Draw dense grid with ORIGINAL screen coordinates
    // Labels show the actual emulator coordinates, not the cropped pixel positions
    const gridStep = 25; // Label every 25 pixels in emulator space

    ctx.fillStyle = '#ccc';
    ctx.font = '10px monospace';

    // X-axis: labels in original screen coords
    ctx.textAlign = 'center';
    const xStart = Math.ceil(sx / gridStep) * gridStep;
    for (let x = xStart; x <= sx + sw; x += gridStep) {
      const px = marginLeft + (x - sx) * scale;
      ctx.fillText(String(x), px, 12);
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 14);
      ctx.lineTo(px, marginTop);
      ctx.stroke();
      // Grid line
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.25)';
      ctx.beginPath();
      ctx.moveTo(px, marginTop);
      ctx.lineTo(px, marginTop + scaledH);
      ctx.stroke();
    }

    // Y-axis: labels in original screen coords
    ctx.textAlign = 'right';
    const yStart = Math.ceil(sy / gridStep) * gridStep;
    for (let y = yStart; y <= sy + sh; y += gridStep) {
      const py = marginTop + (y - sy) * scale;
      ctx.fillText(String(y), marginLeft - 3, py + 4);
      ctx.strokeStyle = '#888';
      ctx.beginPath();
      ctx.moveTo(marginLeft - 2, py);
      ctx.lineTo(marginLeft, py);
      ctx.stroke();
      // Grid line
      ctx.strokeStyle = 'rgba(255, 255, 0, 0.25)';
      ctx.beginPath();
      ctx.moveTo(marginLeft, py);
      ctx.lineTo(marginLeft + scaledW, py);
      ctx.stroke();
    }

    // Crosshair if cursor is within this region
    if (this.cursorX >= sx && this.cursorX <= sx + sw &&
        this.cursorY >= sy && this.cursorY <= sy + sh) {
      const cx = marginLeft + (this.cursorX - sx) * scale;
      const cy = marginTop + (this.cursorY - sy) * scale;
      const size = 15;
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - size, cy);
      ctx.lineTo(cx + size, cy);
      ctx.moveTo(cx, cy - size);
      ctx.lineTo(cx, cy + size);
      ctx.stroke();
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - size, cy);
      ctx.lineTo(cx + size, cy);
      ctx.moveTo(cx, cy - size);
      ctx.lineTo(cx, cy + size);
      ctx.stroke();
    }

    const dataUrl = offscreen.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    this.sendResult(cmd.id, {
      image: base64,
      regionX: sx,
      regionY: sy,
      regionWidth: sw,
      regionHeight: sh,
    });
  }

  private handleMouseMove(cmd: AutomationCommand): void {
    const x = cmd.x as number;
    const y = cmd.y as number;
    this.cursorX = x;
    this.cursorY = y;
    this.writer.writeMousePosition(x, y);
    this.sendResult(cmd.id);
  }

  /**
   * Write mouse button state directly to shared memory, bypassing the queue.
   * Also sets the mousePositionFlag to wake the emulator worker so it reads
   * the button state on its next input poll.
   */
  private writeMouseButtonDirect(button: number, pressed: boolean): void {
    const addr = button === 0
      ? InputBufferAddresses.mouseButtonStateAddr
      : InputBufferAddresses.mouseButton2StateAddr;
    Atomics.store(this.inputBuffer, addr, pressed ? 1 : 0);
    // Set the mouse position flag to wake the worker -- it checks this flag
    // on each poll and reads button state alongside position
    Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionFlagAddr, 1);
    Atomics.notify(this.inputBuffer, InputBufferAddresses.globalLockAddr);
  }

  private async handleMouseClick(cmd: AutomationCommand): Promise<void> {
    const x = cmd.x as number;
    const y = cmd.y as number;
    const button = (cmd.button as number) ?? 0; // 0 = left, 1 = right
    const clickCount = (cmd.clickCount as number) ?? 1;

    // Track cursor position
    this.cursorX = x;
    this.cursorY = y;

    for (let i = 0; i < clickCount; i++) {
      if (i > 0) await sleep(100);

      // Write position before button down so the worker reads them together
      Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionXAddr, Math.round(x));
      Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionYAddr, Math.round(y));
      this.writeMouseButtonDirect(button, true);
      await sleep(100);

      this.writeMouseButtonDirect(button, false);
      await sleep(50);
    }

    this.sendResult(cmd.id);
  }

  private async handleTypeText(cmd: AutomationCommand): Promise<void> {
    const text = cmd.text as string;

    for (const char of text) {
      const mapping = CHAR_TO_KEY_CODE[char];
      if (!mapping) continue;

      const adbCode = ADB_KEY_CODES[mapping.code];
      if (adbCode === undefined) continue;

      if (mapping.shift) {
        this.writer.writeModifiers(Modifiers.SHIFT);
        this.writer.writeKeyEvent(ADB_KEY_CODES['ShiftLeft'], true);
        await sleep(10);
      }

      this.writer.writeKeyEvent(adbCode, true);
      await sleep(20);
      this.writer.writeKeyEvent(adbCode, false);
      await sleep(10);

      if (mapping.shift) {
        this.writer.writeKeyEvent(ADB_KEY_CODES['ShiftLeft'], false);
        this.writer.writeModifiers(0);
        await sleep(10);
      }

      // Wait for queue to drain between characters
      await this.waitForQueueDrain(200);
    }

    this.sendResult(cmd.id);
  }

  private async handleKeyPress(cmd: AutomationCommand): Promise<void> {
    const key = cmd.key as string;
    const adbCode = ADB_KEY_CODES[key];
    if (adbCode === undefined) {
      this.sendError(cmd.id, `Unknown key: ${key}`);
      return;
    }

    this.writer.writeKeyEvent(adbCode, true);
    await sleep(30);
    this.writer.writeKeyEvent(adbCode, false);
    await this.waitForQueueDrain(100);

    this.sendResult(cmd.id);
  }

  private async handleKeyCombo(cmd: AutomationCommand): Promise<void> {
    const keys = cmd.keys as string[];
    if (!keys || keys.length === 0) {
      this.sendError(cmd.id, 'No keys specified');
      return;
    }

    // Build modifier mask for the combo
    let modMask = 0;
    for (const key of keys) {
      if (key === 'ShiftLeft' || key === 'ShiftRight') modMask |= Modifiers.SHIFT;
      else if (key === 'ControlLeft' || key === 'ControlRight') modMask |= Modifiers.CTRL;
      else if (key === 'AltLeft' || key === 'AltRight') modMask |= Modifiers.ALT;
      else if (key === 'MetaLeft' || key === 'MetaRight') modMask |= Modifiers.CMD;
    }
    this.writer.writeModifiers(modMask);

    // Press all keys down in order
    for (const key of keys) {
      const adbCode = ADB_KEY_CODES[key];
      if (adbCode === undefined) {
        this.sendError(cmd.id, `Unknown key in combo: ${key}`);
        return;
      }
      this.writer.writeKeyEvent(adbCode, true);
      await sleep(15);
    }

    await sleep(30);

    // Release in reverse order
    for (let i = keys.length - 1; i >= 0; i--) {
      const adbCode = ADB_KEY_CODES[keys[i]];
      if (adbCode !== undefined) {
        this.writer.writeKeyEvent(adbCode, false);
        await sleep(15);
      }
    }

    this.writer.writeModifiers(0);
    await this.waitForQueueDrain(100);

    this.sendResult(cmd.id);
  }

  private async handleMouseDrag(cmd: AutomationCommand): Promise<void> {
    const startX = cmd.startX as number;
    const startY = cmd.startY as number;
    const endX = cmd.endX as number;
    const endY = cmd.endY as number;
    const steps = (cmd.steps as number) ?? 10;
    const btnAddr = InputBufferAddresses.mouseButtonStateAddr;

    this.cursorX = startX;
    this.cursorY = startY;

    // Move to start position
    Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionXAddr, Math.round(startX));
    Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionYAddr, Math.round(startY));
    Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionFlagAddr, 1);
    Atomics.notify(this.inputBuffer, InputBufferAddresses.globalLockAddr);
    await sleep(50);

    // Mouse button down
    Atomics.store(this.inputBuffer, btnAddr, 1);
    Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionFlagAddr, 1);
    Atomics.notify(this.inputBuffer, InputBufferAddresses.globalLockAddr);
    await sleep(50);

    // Move through intermediate steps
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(startX + (endX - startX) * t);
      const y = Math.round(startY + (endY - startY) * t);
      this.cursorX = x;
      this.cursorY = y;
      Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionXAddr, x);
      Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionYAddr, y);
      Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionFlagAddr, 1);
      Atomics.notify(this.inputBuffer, InputBufferAddresses.globalLockAddr);
      await sleep(30);
    }

    // Mouse button up
    Atomics.store(this.inputBuffer, btnAddr, 0);
    Atomics.store(this.inputBuffer, InputBufferAddresses.mousePositionFlagAddr, 1);
    Atomics.notify(this.inputBuffer, InputBufferAddresses.globalLockAddr);
    await sleep(50);

    this.sendResult(cmd.id);
  }

  private async handleWait(cmd: AutomationCommand): Promise<void> {
    const ms = Math.min((cmd.ms as number) ?? 1000, 10000);
    await sleep(ms);
    this.sendResult(cmd.id);
  }

  private async waitForQueueDrain(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (this.writer.hasPendingEvents() && Date.now() - start < timeoutMs) {
      await sleep(5);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.writer.dispose();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
