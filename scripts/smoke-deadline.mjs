/**
 * Observe whether an asynchronous smoke probe settles before its deterministic
 * deadline without letting a stalled probe hold the rest of the harness.
 */
export async function observeBeforeDeadline(promise, timeoutMs) {
  let timeoutId;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ completed: true, value }),
        (error) => ({ completed: true, error }),
      ),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve({ completed: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
