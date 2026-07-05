import { useEffect, useRef, useState } from 'react';

/**
 * Full-screen camera barcode scanner. Uses the phone's back camera via getUserMedia (works in
 * iOS Safari over HTTPS — which we have via the Cloudflare tunnel) and decodes UPC/EAN with
 * @zxing, loaded on demand so it never weighs down the main bundle. Falls back to typing the
 * digits if the camera can't start. Calls onDetected once with the raw barcode string.
 */
export function BarcodeScanner({
  onDetected,
  onClose,
}: {
  onDetected: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cbRef = useRef(onDetected);
  cbRef.current = onDetected;
  const doneRef = useRef(false);
  const [error, setError] = useState<string>();
  const [manual, setManual] = useState('');

  useEffect(() => {
    let controls: { stop: () => void } | undefined;
    let cancelled = false;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera needs a secure (https) connection.');
        return;
      }
      try {
        const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
          import('@zxing/browser'),
          import('@zxing/library'),
        ]);
        // Only retail 1-D formats: faster and far fewer misreads than all-formats.
        const hints = new Map<number, unknown>([
          [
            DecodeHintType.POSSIBLE_FORMATS,
            [BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8],
          ],
        ]);
        const reader = new BrowserMultiFormatReader(hints);
        if (cancelled || !videoRef.current) return;
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: 'environment' } },
          videoRef.current,
          (result) => {
            if (result && !doneRef.current) {
              doneRef.current = true;
              controls?.stop();
              cbRef.current(result.getText());
            }
          },
        );
      } catch (e) {
        setError(
          e instanceof DOMException && e.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access, or type the barcode below.'
            : e instanceof Error
              ? e.message
              : 'Could not start the camera.',
        );
      }
    })();

    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, []);

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    const code = manual.replace(/\D/g, '');
    if (code && !doneRef.current) {
      doneRef.current = true;
      cbRef.current(code);
    }
  }

  return (
    <div className="scanner-overlay">
      <div className="scanner-head">
        <span>📷 Scan a barcode</span>
        <button className="scanner-x" onClick={onClose} aria-label="close scanner">
          ✕
        </button>
      </div>
      {error ? (
        <p className="scanner-error">{error}</p>
      ) : (
        <div className="scanner-frame">
          <video ref={videoRef} className="scanner-video" muted playsInline autoPlay />
          <div className="scanner-reticle" />
          <p className="scanner-hint">Point the back camera at the product barcode</p>
        </div>
      )}
      <form className="scanner-manual" onSubmit={submitManual}>
        <input
          inputMode="numeric"
          placeholder="or type the barcode digits"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button className="btn btn-inline" type="submit" disabled={!manual.replace(/\D/g, '')}>
          Look up
        </button>
      </form>
    </div>
  );
}
