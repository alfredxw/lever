import { useState } from "react";
import jsQR from "jsqr";
export function ScanPairing({ onLink }: { onLink: (v: string) => void }) {
  const [error, setError] = useState("");
  return (
    <>
      <label>
        扫描配对二维码
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setError("");
            const url = URL.createObjectURL(file);
            try {
              const img = new Image();
              img.src = url;
              await img.decode();
              const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
              const canvas = document.createElement("canvas");
              canvas.width = Math.max(1, Math.round(img.width * scale));
              canvas.height = Math.max(1, Math.round(img.height * scale));
              const ctx = canvas.getContext("2d");
              if (!ctx) throw Error();
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              const pixels = ctx.getImageData(
                0,
                0,
                canvas.width,
                canvas.height,
              );
              const qr = jsQR(pixels.data, pixels.width, pixels.height);
              if (!qr || !qr.data.startsWith("leverdevice://pair?"))
                throw Error();
              onLink(qr.data);
            } catch {
              setError("未识别到配对二维码，请重拍或粘贴链接。");
            } finally {
              URL.revokeObjectURL(url);
            }
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
