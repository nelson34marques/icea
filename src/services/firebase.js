import { getApp, getApps, initializeApp } from '@firebase/app';
import { getAnalytics, isSupported } from '@firebase/analytics';
import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from '@firebase/auth';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from '@firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyCmSOzD2HgYHpEDs6gvkkXQnUdr6yJsq14',
  authDomain: 'icea53.firebaseapp.com',
  projectId: 'icea53',
  storageBucket: 'icea53.firebasestorage.app',
  messagingSenderId: '1005413149074',
  appId: '1:1005413149074:web:ca761c6f1b1bef8326f94b',
  measurementId: 'G-R8D44ED52D',
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);

export const analyticsReady = isSupported()
  .then((supported) => (supported ? getAnalytics(firebaseApp) : null))
  .catch(() => null);

const googleProvider = new GoogleAuthProvider();

async function ensureUserProfile(user) {
  const profileRef = doc(db, 'users', user.uid);
  const profileSnapshot = await getDoc(profileRef);

  if (!profileSnapshot.exists()) {
    await setDoc(profileRef, {
      email: user.email || '',
      displayName: user.displayName || '',
      status: 'user',
      createdAt: serverTimestamp(),
    });
  }
}

export async function signInWithGoogle() {
  const result = await signInWithPopup(auth, googleProvider);
  await ensureUserProfile(result.user);
  return result.user;
}

export async function signInWithEmail(email, password) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  await ensureUserProfile(result.user);
  return result.user;
}

export async function registerWithEmail(displayName, email, password) {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  await setDoc(doc(db, 'users', result.user.uid), {
    email,
    displayName,
    status: 'user',
    createdAt: serverTimestamp(),
  });
  return result.user;
}

export function subscribeToAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export function subscribeToUserProfile(user, callback, onError) {
  return onSnapshot(doc(db, 'users', user.uid), (snapshot) => {
    if (snapshot.exists()) {
      callback(snapshot.data());
      return;
    }

    callback({ email: user.email || '', displayName: user.displayName || '', status: 'user' });
    ensureUserProfile(user).catch(onError);
  }, onError);
}

export function subscribeToVisitorRecords(callback, onError) {
  const recordsQuery = query(collection(db, 'visitors'), orderBy('createdAt', 'desc'));
  return onSnapshot(recordsQuery, (snapshot) => {
    callback(snapshot.docs.map((record) => {
      const data = record.data();
      const timestamp = data.createdAt?.toDate?.();
      return {
        ...data,
        id: record.id,
        initials: String(data.name || '').split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase(),
        date: timestamp ? timestamp.toLocaleDateString('pt-PT') : 'Agora',
      };
    }));
  }, onError);
}

export function subscribeToAttendanceRecords(callback, onError) {
  const recordsQuery = query(collection(db, 'attendance'), orderBy('createdAt', 'desc'));
  return onSnapshot(recordsQuery, (snapshot) => {
    callback(snapshot.docs.map((record) => ({ id: record.id, ...record.data() })));
  }, onError);
}

export function addVisitorRecord(visitor, user) {
  return addDoc(collection(db, 'visitors'), {
    name: visitor.name,
    className: visitor.className,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
  });
}

export function addAttendanceRecord(classId, members, selectedIds, user, sessionDate) {
  const attendance = members
    .filter((person) => String(person.class_id) === String(classId))
    .map((person) => ({
      memberId: person.id,
      status: selectedIds.includes(person.id) ? 'Presente' : 'Ausente',
    }));

  return addDoc(collection(db, 'attendance'), {
    classId: String(classId),
    attendance,
    sessionDate: sessionDate || null,
    createdAt: serverTimestamp(),
    createdBy: user.uid,
  });
}

export function signOutUser() {
  return signOut(auth);
}