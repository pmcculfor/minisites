import { CONFIG } from "../config.js";
import { commentFromDoc, photoFromDoc } from "../domain/models.js";

function makeCollectionRepo(db, name, opts) {
  const firestore = opts.firestore;
  const limitN = opts.limit;
  const mapDoc = opts.mapDoc;
  const buildFields = opts.buildFields;

  return {
    subscribe: function (onNext, onError) {
      const q = firestore.query(
        firestore.collection(db, name),
        firestore.orderBy("createdAt", "desc"),
        firestore.limit(limitN)
      );
      return firestore.onSnapshot(
        q,
        (snap) => {
          onNext(snap.docs.map((docSnap) => mapDoc(docSnap.data())));
        },
        onError
      );
    },
    add: function (fields) {
      return firestore.addDoc(firestore.collection(db, name), buildFields(fields));
    },
  };
}

export function createStore(db, opts) {
  const options = opts || {};
  const config = options.config || CONFIG;
  const firestore = options.firestore;
  const auth = options.auth;
  const canWrite = options.canWrite != null ? options.canWrite : Boolean(auth?.currentUser);

  const comments = makeCollectionRepo(db, config.collections.comments, {
    firestore,
    limit: config.limits.commentsQuery,
    mapDoc: commentFromDoc,
    buildFields: (input) => ({
      nickname: input.nickname,
      text: input.text,
      dayKey: input.dayKey,
      createdAt: firestore.serverTimestamp(),
    }),
  });

  const photos = makeCollectionRepo(db, config.collections.photos, {
    firestore,
    limit: config.limits.photosQuery,
    mapDoc: photoFromDoc,
    buildFields: (input) => {
      const uid = auth?.currentUser?.uid;
      return {
        dayKey: input.dayKey,
        url: input.url,
        path: `days/${input.dayKey}/${uid}_${Date.now()}.jpg`,
        createdAt: firestore.serverTimestamp(),
      };
    },
  });

  return {
    canWrite,
    subscribeComments: function (onNext, onError) {
      return comments.subscribe(onNext, onError);
    },
    subscribePhotos: function (onNext, onError) {
      return photos.subscribe(onNext, onError);
    },
    addComment: function (input) {
      return comments.add(input);
    },
    addPhoto: function (input) {
      if (!auth?.currentUser?.uid) {
        return Promise.reject(new Error("anonymous"));
      }
      return photos.add(input);
    },
  };
}
