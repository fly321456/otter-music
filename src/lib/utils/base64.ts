export function base64ToBlob(base64: string, mimeType: string): Blob {
  // Android Base64.DEFAULT inserts \r\n every 76 chars — strip before atob()
  const cleaned = base64.replace(/[\s\r\n]+/g, "");
  const binaryStr = atob(cleaned);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new Blob([bytes.buffer], { type: mimeType });
}

/**
 * 异步版本：使用 fetch + data URL，让浏览器内部优化内存
 * 对大文件更高效，避免在 JS 中创建中间二进制字符串
 */
export async function base64ToBlobAsync(base64: string, mimeType: string): Promise<Blob> {
  const cleaned = base64.replace(/[\s\r\n]+/g, "");
  const dataUrl = `data:${mimeType};base64,${cleaned}`;
  const res = await fetch(dataUrl);
  return res.blob();
}

/**
 * 直接将 base64 转换为 ArrayBuffer，避免创建中间 Blob
 * 内存效率最高：base64 → ArrayBuffer（约 1x 原始大小）
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const cleaned = base64.replace(/[\s\r\n]+/g, "");
  const binaryStr = atob(cleaned);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes.buffer;
}
