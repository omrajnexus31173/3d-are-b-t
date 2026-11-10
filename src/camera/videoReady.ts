/**
 * Small helper that resolves once a video element has real frame dimensions.
 * `loadedmetadata` is not always enough on some mobile browsers, so we also
 * poll `videoWidth` with a short timeout.
 */
export function observeVideoReady(
  video: HTMLVideoElement,
  timeoutMs = 6000
): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let done = false;
    let raf = 0;
    const started = performance.now();

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('resize', onMeta);
      if (ok) resolve();
      else reject(new Error('Camera stream produced no video frames (timeout).'));
    };

    const onMeta = () => {
      if (video.videoWidth > 0) finish(true);
    };

    const tick = () => {
      if (done) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        finish(true);
        return;
      }
      if (performance.now() - started > timeoutMs) {
        finish(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('resize', onMeta);
    raf = requestAnimationFrame(tick);
  });
}
