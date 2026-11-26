import { useState } from "react";
import jsQR from "jsqr";
import { QrCode } from "lucide-react";

export function ScanPairing({ onLink }: { onLink: (v: string) => void }) {
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <label className="hub-scan-trigger">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <QrCode className="size-5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col text-left">
          <span className="text-[14px] font-medium text-foreground">
            {scanning ? "正在识别二维码…" : "扫描配对二维码"}
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            打开电脑 Lever「设置 → 远程与设备」点击配对新设备
          </span>
        </span>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setError("");
            setScanning(true);
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
              setError("未识别到配对二维码，请重拍或直接粘贴配对链接。");
            } finally {
              setScanning(false);
              URL.revokeObjectURL(url);
            }
          }}
        />
      </label>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
