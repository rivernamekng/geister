// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCRCQi0IoucY8jwgDRDogKnr8_lpGtOWKY",
  authDomain: "geister-6d6cf.firebaseapp.com",
  databaseURL: "https://geister-6d6cf-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "geister-6d6cf",
  storageBucket: "geister-6d6cf.firebasestorage.app",
  messagingSenderId: "677190632266",
  appId: "1:677190632266:web:56f87540f96d82c8f7f7b3",
  measurementId: "G-PSR8QJ4HTG"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
