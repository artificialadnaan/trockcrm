import React from "react";
import { Stack } from "expo-router";

/** Stack inside the Reports tab so the weekly-report wizard pushes over the hub. */
export default function ReportsStack() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
