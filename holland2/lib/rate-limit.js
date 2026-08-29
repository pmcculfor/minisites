export function createCooldown(ms) {
  let lastSuccess = 0;
  return {
    isBlocked: function () {
      return Date.now() - lastSuccess < ms;
    },
    stamp: function () {
      lastSuccess = Date.now();
    },
  };
}

export function createRateLimiters(config) {
  return {
    comment: createCooldown(config.rateLimit.commentMs),
    photo: createCooldown(config.rateLimit.photoMs),
  };
}
