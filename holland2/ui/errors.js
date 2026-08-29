export const ERRORS = {
  weatherBothFailed:
    "Could not load Holland conditions. Refresh the page to try again.",
  firebaseUnconfigured:
    "Notes and pictures are not connected yet. Add your Firebase keys in firebase-config.js (see README).",
  firebaseUnconfiguredComment:
    "Firebase is not configured yet, so comments cannot be saved.",
  firebaseUnconfiguredPhoto:
    "Firebase is not configured yet, so pictures cannot be saved.",
  authFailed:
    "Could not start an anonymous session. Check Auth is enabled and pmcculfor.github.io is an authorized domain.",
  commentsSnapshot:
    "Could not load notes. Check Firestore rules and App Check.",
  photosSnapshot:
    "Could not load pictures. Check Firestore rules and App Check.",
  commentPost:
    "Could not post. If App Check is enforced, the reCAPTCHA site key must be set and the domain allowed.",
  commentEmpty: "Write a comment first.",
  commentCooldown: "Wait a few seconds before posting again.",
  commentPosting: "Posting…",
  commentPosted: "Posted.",
  honeypotThanks: "Thanks.",
  photoPermission:
    "Could not save the picture. Publish the latest firestore.rules from this repo in the Firebase console.",
  photoAuth: "Could not start an anonymous session for uploads.",
  photoAppCheck:
    "Could not save the picture. Check App Check and the reCAPTCHA site key for this domain.",
  photoTimeout:
    "The picture took too long to save. Try a smaller photo or another network.",
  photoUnreadable: "Could not read that picture. Try a JPEG or PNG.",
  photoTooLarge: "That picture is still too large after shrinking. Try another photo.",
  photoNotImage: "Use a photo file (JPEG, PNG, WebP, HEIC, or GIF).",
  photoFileTooLarge: "That picture is over 20 MB.",
  photoCooldown: "Wait a few seconds before uploading again.",
  photoGeneric: "Could not save the picture. Try again in a moment.",
  photoReading: "Reading picture…",
  photoShrinking: "Shrinking picture…",
  photoSaving: "Saving picture…",
  photoUploaded: "Uploaded.",
  feedLoadingNotes: "Loading notes…",
  feedLoadingPictures: "Loading pictures…",
  feedEmptyNotes: "No notes for this day yet.",
  feedEmptyPictures: "No pictures yet.",
};

export function mapPhotoError(error) {
  const code = String(error?.code || error?.message || "");
  if (code.includes("permission") || code.includes("PERMISSION")) return ERRORS.photoPermission;
  if (code.includes("unauthenticated") || code.includes("anonymous")) return ERRORS.photoAuth;
  if (code.includes("app-check") || code.includes("recaptcha") || code.includes("AppCheck")) {
    return ERRORS.photoAppCheck;
  }
  if (code.includes("timeout") || code.includes("timed out")) return ERRORS.photoTimeout;
  if (code.includes("unreadable") || code.includes("compress-failed")) return ERRORS.photoUnreadable;
  if (code.includes("too-large")) return ERRORS.photoTooLarge;
  return ERRORS.photoGeneric;
}
