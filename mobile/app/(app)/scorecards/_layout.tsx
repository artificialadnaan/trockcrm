import React from "react";
import { Stack } from "expo-router";

/** Stack inside the Scorecard tab so the wizard pushes over the list. */
export default function ScorecardsStack() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
