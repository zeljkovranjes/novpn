// Cloudflare's runtime sets navigator.userAgent to "Cloudflare-Workers". This
// is the documented detection mechanism (see workerd source). Used to gate
// Node-only paths (DNS lookup, fs, node-cron, setImmediate-only behaviour).
export function isWorkers(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as { userAgent?: string }).userAgent === 'Cloudflare-Workers'
  );
}
