import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../lib/api.js';

async function loadReader() {
  const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library'),
  ]);
  const hints = new Map<number, unknown>([
    [
      DecodeHintType.POSSIBLE_FORMATS,
      [
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.CODE_128,
        // GS1 DataBar family — produce stickers are usually DataBar (Expanded) Stacked.
        BarcodeFormat.RSS_14,
        BarcodeFormat.RSS_EXPANDED,
      ],
    ],
  ]);
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
  const names: Record<number, string> = {};
  for (const k of Object.keys(BarcodeFormat)) {
    const v = (BarcodeFormat as Record<string, unknown>)[k];
    if (typeof v === 'number') names[v] = k;
  }
  return { reader, fmtName: (n: number) => names[n] ?? String(n) };
}

type Status = 'starting' | 'scanning' | 'error';

/**
 * Live barcode scanner. We drive the decode loop ourselves (getUserMedia -> draw each video
 * frame to a canvas -> decode) because zxing's built-in continuous decoder is unreliable on iOS.
 * Debug mode (🐞) surfaces camera resolution, frames scanned, and the last decode so we can see
 * whether the camera + decoder are working at all.
 */
export function BarcodeScanner({
  onDetected,
  onClose,
}: {
  onDetected: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<Awaited<ReturnType<typeof loadReader>>>();
  const streamRef = useRef<MediaStream>();
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const cbRef = useRef(onDetected);
  cbRef.current = onDetected;
  const doneRef = useRef(false);
  const debugRef = useRef(false);
  const dbgRef = useRef({ frames: 0, dims: '—', last: '', lastCode: '' });
  const [status, setStatus] = useState<Status>('starting');
  const [error, setError] = useState<string>();
  const [tapMsg, setTapMsg] = useState<string>();
  const [manual, setManual] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [debug, setDebug] = useState(false);
  debugRef.current = debug;
  const [, forceRender] = useState(0);
  const rerender = () => forceRender((x) => x + 1);

  function stopCamera() {
    if (timerRef.current) clearTimeout(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  function finish(code: string) {
    if (doneRef.current) return;
    doneRef.current = true;
    stopCamera();
    cbRef.current(code);
  }

  function decodeFrame(): boolean {
    const video = videoRef.current;
    const loaded = readerRef.current;
    if (!video || !loaded || !video.videoWidth || !video.videoHeight) return false;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const result = loaded.reader.decodeFromCanvas(canvas);
      const text = result.getText();
      if (debugRef.current) {
        // Show what was read; let the user confirm it rather than auto-closing.
        dbgRef.current.last = `${loaded.fmtName(result.getBarcodeFormat())}: ${text}`;
        dbgRef.current.lastCode = text;
        rerender();
        return true;
      }
      finish(text); // zxing checksum-validates the decode
      return true;
    } catch {
      return false; // no barcode in this frame
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('error');
        setError('Live camera needs an https connection. Type the barcode digits below instead.');
        return;
      }
      try {
        readerRef.current = await loadReader();
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
        });
        streamRef.current = stream;
        const video = videoRef.current;
        if (cancelled || !video) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        video.muted = true;
        video.setAttribute('playsinline', 'true');
        await video.play().catch(() => {});
        setStatus('scanning');

        const tick = () => {
          if (cancelled || doneRef.current) return;
          dbgRef.current.frames++;
          dbgRef.current.dims = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '0×0 (no frames)';
          decodeFrame();
          if (debugRef.current) rerender();
          if (!doneRef.current) timerRef.current = setTimeout(tick, 250);
        };
        tick();
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        setError(
          e instanceof DOMException && e.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow it in Safari settings, or type the digits below.'
            : e instanceof Error
              ? e.message
              : 'Could not start the camera. Type the digits below instead.',
        );
      }
    })();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, []);

  async function onTap() {
    if (doneRef.current || analyzing) return;
    const video = videoRef.current;
    if (!video?.videoWidth) {
      setTapMsg('Camera still starting — give it a second, then tap again.');
      return;
    }
    // 1) Quick local decode — instant for a normal barcode already in frame.
    if (decodeFrame()) return;
    // 2) Produce sticker: capture the frame and let the server vision-read the printed PLU/name.
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1280 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1] ?? '';
    setAnalyzing(true);
    setTapMsg('Reading the label…');
    try {
      const r = await api.post<{ code: string | null; name?: string | null; plu?: string | null; message?: string }>(
        '/items/scan-image',
        { imageBase64: base64, mediaType: 'image/jpeg' },
      );
      if (r.code) {
        finish(r.code);
        return;
      }
      setTapMsg(
        r.name
          ? `Read “${r.name}”${r.plu ? ` (PLU ${r.plu})` : ''} but couldn’t match it — type the PLU below.`
          : (r.message ?? 'Couldn’t read a code — type the PLU below.'),
      );
    } catch (e) {
      setTapMsg(e instanceof Error ? e.message : 'Analysis failed — type the PLU below.');
    } finally {
      setAnalyzing(false);
    }
  }

  function submitManual(e: FormEvent) {
    e.preventDefault();
    const code = manual.replace(/\D/g, '');
    if (code) finish(code);
  }

  const dbg = dbgRef.current;
  return (
    <div className="scanner-overlay">
      <div className="scanner-head">
        <span>📷 Scan a barcode</span>
        <span>
          <button
            className={`scanner-dbg ${debug ? 'on' : ''}`}
            onClick={() => setDebug((d) => !d)}
            aria-label="debug"
          >
            🐞
          </button>
          <button className="scanner-x" onClick={onClose} aria-label="close scanner">
            ✕
          </button>
        </span>
      </div>

      {status === 'error' ? (
        <div className="scanner-error">{error}</div>
      ) : (
        <button type="button" className="scanner-frame" onClick={onTap} aria-label="tap to scan the barcode">
          <video ref={videoRef} className="scanner-video" muted playsInline autoPlay />
          <div className="scanner-reticle" />
          {debug && (
            <div className="scanner-debug">
              <div>camera: {dbg.dims}</div>
              <div>frames scanned: {dbg.frames}</div>
              <div>last read: {dbg.last || '— nothing yet'}</div>
              {dbg.lastCode && (
                <button className="btn btn-inline" onClick={() => finish(dbg.lastCode)}>
                  ✓ Use “{dbg.lastCode}”
                </button>
              )}
            </div>
          )}
          <p className="scanner-hint">
            {status === 'starting'
              ? 'Starting camera…'
              : (tapMsg ?? 'Barcodes scan automatically. For a produce sticker, tap the screen to read the PLU.')}
          </p>
        </button>
      )}

      <form className="scanner-manual" onSubmit={submitManual}>
        <input
          inputMode="numeric"
          placeholder="or type a barcode / produce PLU (e.g. 4011)"
          value={manual}
          onChange={(ev) => setManual(ev.target.value)}
        />
        <button className="btn btn-inline" type="submit" disabled={!manual.replace(/\D/g, '')}>
          Go
        </button>
      </form>
    </div>
  );
}
