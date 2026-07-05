import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

// Retail 1-D formats we care about (plus CODE_128 for the odd store label).
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
        BarcodeFormat.RSS_14, // GS1 DataBar — the barcode on many produce stickers (PLU)
        BarcodeFormat.RSS_EXPANDED,
      ],
    ],
  ]);
  return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 });
}

type Status = 'starting' | 'scanning' | 'error';

/**
 * Live barcode scanner. The camera preview decodes CONTINUOUSLY on its own — everything runs
 * locally in the browser (zxing on the video frames); nothing is uploaded, only the decoded
 * digits go to the server for lookup. Tapping the preview forces a one-shot decode of the
 * current frame (same local pipeline — never the native camera app), as a manual backup when
 * continuous decode is being stubborn. Typing the digits is the last resort.
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
  const cbRef = useRef(onDetected);
  cbRef.current = onDetected;
  const doneRef = useRef(false);
  const controlsRef = useRef<{ stop: () => void }>();
  const [status, setStatus] = useState<Status>('starting');
  const [error, setError] = useState<string>();
  const [tapMsg, setTapMsg] = useState<string>();
  const [manual, setManual] = useState('');

  function finish(code: string) {
    if (doneRef.current) return;
    doneRef.current = true;
    controlsRef.current?.stop();
    cbRef.current(code);
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
        const reader = await loadReader();
        readerRef.current = reader;
        const video = videoRef.current;
        if (cancelled || !video) return;
        // iOS autoplay: the muted *property* (not just the attribute) must be set, or the video
        // won't play and there are no frames to decode.
        video.muted = true;
        video.setAttribute('playsinline', 'true');
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } } },
          video,
          (result) => {
            if (result) finish(result.getText());
          },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setStatus('scanning');
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
      controlsRef.current?.stop();
    };
  }, []);

  // Manual backup: decode the current video frame locally (no native camera app).
  function scanCurrentFrame() {
    const video = videoRef.current;
    const reader = readerRef.current;
    if (!video || !reader || doneRef.current) return;
    if (!video.videoWidth || !video.videoHeight) {
      setTapMsg('Camera still starting — give it a second, then tap again.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const result = reader.decodeFromCanvas(canvas);
      finish(result.getText());
    } catch {
      setTapMsg('No barcode read — fill the box with the barcode and tap again.');
    }
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
        <button
          type="button"
          className="scanner-frame"
          onClick={scanCurrentFrame}
          aria-label="tap to scan the barcode"
        >
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
