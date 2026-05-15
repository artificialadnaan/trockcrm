import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportToExcel, type ExcelSheet } from "@/lib/excel-export";

export function ExportExcelButton({
  filename,
  sheets,
  disabled,
}: {
  filename: string;
  sheets: ExcelSheet[];
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || sheets.length === 0}
      onClick={() => exportToExcel({ filename, sheets })}
    >
      <Download className="mr-2 h-4 w-4" />
      Export to Excel
    </Button>
  );
}

