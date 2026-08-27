export const debounce = (callback: Function, wait = 200) => {
  let timeoutId: number | undefined;
  return (...args: Array<unknown>) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      callback.apply(null, args);
    }, wait);
  };
};
