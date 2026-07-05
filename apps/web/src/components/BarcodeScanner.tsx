import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

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
        // GS1 DataBar family — the barcode on produce stickers is usually DataBar (Expanded)
        // Stacked, which needs RSS_EXPANDED. zxing checksum-validates these.
        BarcodeFormat.RSS_14,
        BarcodeFormat.RSS_EXPANDED,
      ],
    ],
  ]);
  return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
}

type Status = 'starting' | 'scanning' | 'error';

/**
 * Live barcode scanner. We drive the decode loop ourselves — get the camera stream, then on a
 * timer draw the current video frame to a canvas and decode it with zxing. This is far more
 * reliable on iOS Safari than zxing's built-in continuous decoder, whose internal frame capture
 * often never fires (preview plays, but nothing decodes). Everything runs locally; only the
 * decoded digits are sent for lookup. Tap the preview to force an immediate decode; typing the
 * digits is the last resort.
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
  const [status, setStatus] = useState<Status>('starting');
  const [error, setError] = useState<string>();
  const [tapMsg, setTapMsg] = useState<string>();
  const [manual, setManual] = useState('');

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
    const reader = readerRef.current;
    if (!video || !reader || !video.videoWidth || !video.videoHeight) return false;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      finish(reader.decodeFromCanvas(canvas).getText()); // zxing checksum-validates the decode
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
          decodeFrame();
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

  function onTap() {
    if (doneRef.current) return;
    if (!videoRef.current?.videoWidth) {
      setTapMsg('Camera still starting — give it a second, then tap again.');
      return;
    }
    if (!decodeFrame()) setTapMsg('No barcode read — fill the box with the barcode and tap again.');
  }

  function submitManual(e: FormEvent) {
    e.preventDefault();
    const code = manual.replace(/\D/g, '');
    if (code) finish(code);
  }

  return (
    <div className="scanner-overlay">
      <div className="scanner-head">
        <span>📷 Scan a barcode</span>
        <button className="scanner-x" onClick={onClose} aria-label="close scanner">
          ✕
        </button>
      </div>

      {status === 'error' ? (
        <div className="scanner-error">{error}</div>
      ) : (
        <button type="button" className="scanner-frame" onClick={onTap} aria-label="tap to scan the barcode">
          <video ref={videoRef} className="scanner-video" muted playsInline autoPlay />
          <div className="scanner-reticle" />
          <p className="scanner-hint">
            {status === 'starting'
              ? 'Starting camera…'
              : (tapMsg ?? 'Center the barcode — it scans automatically, or tap the screen to scan')}
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
