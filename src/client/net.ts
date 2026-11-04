// WebSocket link to the Nostaru server. Messages are queued and drained by the scene each frame.
import type { ClientMsg, ServerMsg } from '../net/protocol';
import type { Intent } from '../sim/world';

export class Net {
  queue: ServerMsg[] = [];
  last: Extract<ServerMsg, { t: 'tick' }> | null = null;
  myId = -1; map = ''; cls = '';
  saves: Record<string, { cls: string; level: number }> = {};
  onMsg: ((m: ServerMsg) => void) | null = null;
  closed = false;

  private constructor(private ws: WebSocket) {
    ws.onmessage = e => {
      const m = JSON.parse(e.data) as ServerMsg;
      if (m.t === 'tick') this.last = m;
      if (m.t === 'welcome') { this.myId = m.id; this.map = m.map; this.cls = m.cls; }
      if (m.t === 'hello') this.saves = m.saves;
      this.queue.push(m);
      this.onMsg?.(m);
    };
    ws.onclose = () => { this.closed = true; this.onMsg?.({ t: 'error', text: 'หลุดจากเซิร์ฟเวอร์ — รีเฟรชหน้าเพื่อเข้าใหม่' }); };
  }

  /** Resolves to null when there is no server (GitHub Pages, Claude artifact, file://). */
  static connect(timeoutMs = 1500): Promise<Net | null> {
    if (!/^https?:$/.test(location.protocol)) return Promise.resolve(null);
    return new Promise(resolve => {
      let ws: WebSocket;
      try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); } catch { resolve(null); return; }
      const net = new Net(ws);
      const timer = setTimeout(() => { ws.close(); resolve(null); }, timeoutMs);
      const prev = ws.onmessage!;
      ws.onmessage = e => { prev.call(ws, e); if (net.queue.some(m => m.t === 'hello')) { clearTimeout(timer); ws.onmessage = prev; resolve(net); } };
      ws.onerror = () => { clearTimeout(timer); resolve(null); };
    });
  }

  send(m: ClientMsg) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  intent(i: Intent) { this.send({ t: 'intent', intent: i }); }
}
