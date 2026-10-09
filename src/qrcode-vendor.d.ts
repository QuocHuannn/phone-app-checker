// qrcode-terminal ships its QR encoder as plain CommonJS files with no typings; src/qr.ts uses it directly
// (only the module matrix is needed, the drawing is done in src/qr.ts).
declare module 'qrcode-terminal/vendor/QRCode/index.js' {
  export default class QRCode {
    /** `typeNumber` -1 picks the smallest version that holds the data. */
    constructor(typeNumber: number, errorCorrectLevel: number);
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    /** `modules[row][column]`: true = dark. Present after `make()`. */
    modules: boolean[][];
  }
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js' {
  const QRErrorCorrectLevel: { L: number; M: number; Q: number; H: number };
  export default QRErrorCorrectLevel;
}
