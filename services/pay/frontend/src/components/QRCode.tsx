// Thin wrapper to hand off to qrcode.react without giving the rest of the
// app a direct dependency path — easier to swap the library later.
import { QRCodeCanvas } from 'qrcode.react';

export default function QRCode({ value, size = 280 }: { value: string; size?: number }) {
  return (
    <div
      style={{
        background: 'white',
        padding: 16,
        borderRadius: 12,
        display: 'inline-block',
        lineHeight: 0,
      }}
    >
      <QRCodeCanvas value={value} size={size} includeMargin={false} />
    </div>
  );
}
