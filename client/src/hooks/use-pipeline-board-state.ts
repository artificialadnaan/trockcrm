import { useEffect, useState } from "react";

export function usePipelineBoardState(defaultEntity: "deals" | "leads") {
  const [activeEntity, setActiveEntity] = useState<"deals" | "leads">(() => {
    if (typeof window === "undefined") return defaultEntity;
    const saved = window.sessionStorage.getItem("pipeline-board-entity");
    return saved === "deals" || saved === "leads" ? saved : defaultEntity;
  });
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem("pipeline-board-entity", activeEntity);
  }, [activeEntity]);

  return { activeEntity, setActiveEntity, search, setSearch };
}
