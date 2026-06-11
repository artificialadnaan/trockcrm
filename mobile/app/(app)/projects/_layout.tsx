import React from "react";
import { Stack } from "expo-router";

/** Stack inside the Projects tab so the detail page pushes over the list. */
export default function ProjectsStack() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
