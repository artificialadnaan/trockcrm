import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, Calculator, FileDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

interface EstimateItem {
  id: string;
  sectionId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  totalPrice: string;
  displayOrder: number;
}

interface EstimateSection {
  id: string;
  dealId: string;
  name: string;
  subtotal: string;
  displayOrder: number;
  items: EstimateItem[];
}

const fmt = (value: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    typeof value === "string" ? parseFloat(value) || 0 : value
  );

interface DealEstimatesTabProps {
  dealId: string;
  proposalMode?: boolean;
}

export function DealEstimatesTab({ dealId, proposalMode = false }: DealEstimatesTabProps) {
  const [sections, setSections] = useState<EstimateSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [addingSection, setAddingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [taxRate, setTaxRate] = useState("0");

  const fetchEstimates = useCallback(async () => {
    setLoading(true);
    try {
      const estimateData = await api<{ sections: EstimateSection[] }>(`/deals/${dealId}/estimates`);
      setSections(estimateData.sections);
      setError(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load estimates");
      setError("Failed to load estimates");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    fetchEstimates();
  }, [fetchEstimates]);

  const grandTotal = sections.reduce(
    (sum, s) => sum + (parseFloat(s.subtotal) || 0),
    0
  );
  const totals = calculateEstimateTotals(sections, taxRate);

  const toggleCollapse = (sectionId: string) => {
    setCollapsed((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };

  const handleAddSection = async () => {
    const name = newSectionName.trim();
    if (!name) return;
    try {
      await api(`/deals/${dealId}/estimates/sections`, {
        method: "POST",
        json: { name },
      });
      setNewSectionName("");
      setAddingSection(false);
      fetchEstimates();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create section");
    }
  };

  const handleExportPdf = () => {
    try {
      exportEstimatePdf({ dealId, sections, taxRate });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to export PDF");
    }
  };

  const handleDeleteSection = async (sectionId: string, name: string) => {
    if (!window.confirm(`Delete section "${name}" and all its items?`)) return;
    try {
      await api(`/deals/${dealId}/estimates/sections/${sectionId}`, {
        method: "DELETE",
      });
      toast.success("Section deleted");
      fetchEstimates();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete section");
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-32 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-muted-foreground">{error}</p>
        <button
          className="mt-2 text-sm text-[#CC0000] hover:underline"
          onClick={fetchEstimates}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border bg-background p-4">
        <div>
          <h3 className="text-sm font-semibold">{proposalMode ? "Proposal Draft" : "Estimate"}</h3>
          <p className="text-sm text-muted-foreground">
            {proposalMode
              ? "Use estimate line items as the starting point for the client proposal."
              : "Build line items, review tax, and export a client-ready PDF."}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Tax rate %
            <Input
              value={taxRate}
              onChange={(event) => setTaxRate(event.target.value)}
              inputMode="decimal"
              className="h-8 w-24 text-right"
              aria-label="Tax rate percent"
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportPdf}
            disabled={sections.length === 0}
          >
            <FileDown className="h-4 w-4 mr-1" />
            Export PDF
          </Button>
        </div>
      </div>
      {sections.length === 0 && !addingSection ? (
        <div className="text-center py-12 border rounded-lg bg-muted/20">
          <Calculator className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <h4 className="text-sm font-semibold text-foreground">No estimate line items yet</h4>
          <p className="text-sm text-muted-foreground mb-3">
            Add a section, then enter quantities and unit prices to build the estimate.
          </p>
          <Button size="sm" onClick={() => setAddingSection(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Add Section
          </Button>
        </div>
      ) : (
        <>
          {sections.map((section) => (
            <SectionBlock
              key={section.id}
              dealId={dealId}
              section={section}
              collapsed={!!collapsed[section.id]}
              onToggle={() => toggleCollapse(section.id)}
              onDelete={() => handleDeleteSection(section.id, section.name)}
              onRefresh={fetchEstimates}
            />
          ))}

          {addingSection ? (
            <div className="flex items-center gap-2 p-3 border rounded-lg bg-muted/20">
              <Input
                autoFocus
                value={newSectionName}
                onChange={(e) => setNewSectionName(e.target.value)}
                placeholder="Section name"
                className="max-w-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddSection();
                  if (e.key === "Escape") {
                    setAddingSection(false);
                    setNewSectionName("");
                  }
                }}
              />
              <Button size="sm" onClick={handleAddSection}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAddingSection(false);
                  setNewSectionName("");
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddingSection(true)}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Section
            </Button>
          )}

          {sections.length > 0 && (
            <div className="flex justify-end border-t pt-4">
              <div className="w-full max-w-xs space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-medium">{fmt(grandTotal)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Tax ({totals.taxRatePercent.toFixed(2)}%)</span>
                  <span className="font-medium">{fmt(totals.taxAmount)}</span>
                </div>
                <div className="flex items-center justify-between border-t pt-2">
                  <span className="text-sm font-semibold">Grand Total</span>
                  <span className="text-2xl font-bold">{fmt(totals.total)}</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SectionBlock({
  dealId,
  section,
  collapsed,
  onToggle,
  onDelete,
  onRefresh,
}: {
  dealId: string;
  section: EstimateSection;
  collapsed: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRefresh: () => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [sectionName, setSectionName] = useState(section.name);
  const [addingItem, setAddingItem] = useState(false);
  const [newItem, setNewItem] = useState({
    description: "",
    quantity: "",
    unit: "",
    unitPrice: "",
  });

  const handleSectionNameBlur = async () => {
    setEditingName(false);
    const name = sectionName.trim();
    if (!name || name === section.name) return;
    try {
      await api(`/deals/${dealId}/estimates/sections/${section.id}`, {
        method: "PATCH",
        json: { name },
      });
      onRefresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update section");
      setSectionName(section.name);
    }
  };

  const handleAddItem = async () => {
    const desc = newItem.description.trim();
    if (!desc) {
      toast.error("Description is required");
      return;
    }
    try {
      await api(`/deals/${dealId}/estimates/sections/${section.id}/items`, {
        method: "POST",
        json: {
          description: desc,
          quantity: newItem.quantity || "1",
          unit: newItem.unit || "ea",
          unitPrice: newItem.unitPrice || "0",
        },
      });
      setNewItem({ description: "", quantity: "", unit: "", unitPrice: "" });
      setAddingItem(false);
      onRefresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add item");
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!window.confirm("Delete this item?")) return;
    try {
      await api(`/deals/${dealId}/estimates/items/${itemId}`, { method: "DELETE" });
      toast.success("Item deleted");
      onRefresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete item");
    }
  };

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-muted/30 border-b">
        <button
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center -m-2"
          aria-label={collapsed ? "Expand section" : "Collapse section"}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>

        {editingName ? (
          <Input
            autoFocus
            value={sectionName}
            onChange={(e) => setSectionName(e.target.value)}
            onBlur={handleSectionNameBlur}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSectionNameBlur();
              if (e.key === "Escape") {
                setSectionName(section.name);
                setEditingName(false);
              }
            }}
            className="h-7 text-sm font-medium max-w-xs"
          />
        ) : (
          <button
            className="text-sm font-semibold hover:text-brand-red transition-colors flex-1 text-left"
            onClick={() => setEditingName(true)}
          >
            {section.name}
          </button>
        )}

        <span className="text-xs text-muted-foreground">
          {section.items.length} item{section.items.length !== 1 ? "s" : ""}
        </span>
        <span className="text-sm font-semibold ml-2">{fmt(section.subtotal)}</span>
        <button
          onClick={onDelete}
          className="text-muted-foreground hover:text-red-600 transition-colors p-2.5 rounded ml-1 min-h-[44px] min-w-[44px] flex items-center justify-center -m-1"
          aria-label="Delete section"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {!collapsed && (
        <div className="overflow-x-auto">
          {section.items.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/10">
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">
                    Description
                  </th>
                  <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium w-20">
                    Qty
                  </th>
                  <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium w-20">
                    Unit
                  </th>
                  <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium w-28">
                    Unit Price
                  </th>
                  <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium w-28">
                    Total
                  </th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {section.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    dealId={dealId}
                    item={item}
                    onDelete={() => handleDeleteItem(item.id)}
                    onRefresh={onRefresh}
                  />
                ))}
              </tbody>
            </table>
          )}

          {addingItem ? (
            <div className="px-4 py-3 border-t bg-muted/10 flex items-center gap-2 flex-wrap">
              <Input
                autoFocus
                value={newItem.description}
                onChange={(e) => setNewItem((p) => ({ ...p, description: e.target.value }))}
                placeholder="Description"
                className="h-7 text-sm flex-1 min-w-40"
              />
              <Input
                value={newItem.quantity}
                onChange={(e) => setNewItem((p) => ({ ...p, quantity: e.target.value }))}
                placeholder="Qty"
                className="h-7 text-sm w-16"
                type="number"
              />
              <Input
                value={newItem.unit}
                onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))}
                placeholder="Unit"
                className="h-7 text-sm w-16"
              />
              <Input
                value={newItem.unitPrice}
                onChange={(e) => setNewItem((p) => ({ ...p, unitPrice: e.target.value }))}
                placeholder="Unit Price"
                className="h-7 text-sm w-28"
                type="number"
              />
              <Button size="sm" className="h-7" onClick={handleAddItem}>
                Add
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => {
                  setAddingItem(false);
                  setNewItem({ description: "", quantity: "", unit: "", unitPrice: "" });
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="px-4 py-2 border-t">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setAddingItem(true)}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Item
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function calculateEstimateTotals(sections: EstimateSection[], taxRateInput: string | number) {
  const subtotal = sections.reduce((sum, section) => sum + (parseFloat(section.subtotal) || 0), 0);
  const taxRatePercent =
    typeof taxRateInput === "number" ? taxRateInput : parseFloat(taxRateInput.replace("%", ""));
  const normalizedTaxRate = Number.isFinite(taxRatePercent) ? Math.max(0, taxRatePercent) : 0;
  const taxAmount = subtotal * (normalizedTaxRate / 100);

  return {
    subtotal,
    taxRatePercent: normalizedTaxRate,
    taxAmount,
    total: subtotal + taxAmount,
  };
}

export function buildEstimatePdfHtml({
  dealId,
  sections,
  taxRate,
}: {
  dealId: string;
  sections: EstimateSection[];
  taxRate: string | number;
}) {
  const totals = calculateEstimateTotals(sections, taxRate);
  const rows = sections
    .map(
      (section) => `
        <h2>${escapeHtml(section.name)}</h2>
        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th>Qty</th>
              <th>Unit</th>
              <th>Unit Price</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            ${section.items
              .map(
                (item) => `
                  <tr>
                    <td>${escapeHtml(item.description)}</td>
                    <td>${escapeHtml(item.quantity)}</td>
                    <td>${escapeHtml(item.unit)}</td>
                    <td>${fmt(item.unitPrice)}</td>
                    <td>${fmt(item.totalPrice)}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
        <p class="section-total">Section subtotal: ${fmt(section.subtotal)}</p>
      `
    )
    .join("");

  return `<!doctype html>
    <html>
      <head>
        <title>Estimate ${escapeHtml(dealId)}</title>
        <style>
          body { font-family: Arial, sans-serif; color: #0f172a; margin: 32px; }
          h1 { font-size: 24px; margin-bottom: 4px; }
          h2 { font-size: 16px; margin: 28px 0 8px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border-bottom: 1px solid #e2e8f0; padding: 8px; text-align: left; font-size: 12px; }
          th:nth-child(n+2), td:nth-child(n+2) { text-align: right; }
          .section-total, .totals { text-align: right; font-weight: 700; }
          .totals { margin-top: 24px; line-height: 1.8; }
        </style>
      </head>
      <body>
        <h1>Estimate</h1>
        <p>Deal ${escapeHtml(dealId)}</p>
        ${rows}
        <div class="totals">
          <div>Subtotal: ${fmt(totals.subtotal)}</div>
          <div>Tax (${totals.taxRatePercent.toFixed(2)}%): ${fmt(totals.taxAmount)}</div>
          <div>Grand Total: ${fmt(totals.total)}</div>
        </div>
      </body>
    </html>`;
}

export function exportEstimatePdf(input: {
  dealId: string;
  sections: EstimateSection[];
  taxRate: string | number;
}) {
  if (input.sections.length === 0) throw new Error("Add at least one section before exporting");
  const printWindow = window.open("", "_blank", "noopener,noreferrer");
  if (!printWindow) throw new Error("Enable popups to export the estimate PDF");

  printWindow.document.open();
  printWindow.document.write(buildEstimatePdfHtml(input));
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ItemRow({
  dealId,
  item,
  onDelete,
  onRefresh,
}: {
  dealId: string;
  item: EstimateItem;
  onDelete: () => void;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState<keyof EstimateItem | null>(null);
  const [values, setValues] = useState({
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPrice,
  });
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleBlur = async (field: keyof typeof values) => {
    setEditing(null);
    const original = (item as unknown as Record<string, string>)[field];
    if (values[field] === original) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await api(`/deals/${dealId}/estimates/items/${item.id}`, {
          method: "PATCH",
          json: { [field]: values[field] },
        });
        onRefresh();
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : "Failed to update item");
        setValues((prev) => ({ ...prev, [field]: original }));
      }
    }, 0);
  };

  const computedTotal =
    (parseFloat(values.quantity) || 0) * (parseFloat(values.unitPrice) || 0);

  const EditableCell = ({
    field,
    align = "left",
    type = "text",
  }: {
    field: keyof typeof values;
    align?: "left" | "right";
    type?: string;
  }) => (
    <td
      className={`px-3 py-2 ${align === "right" ? "text-right" : ""}`}
      onClick={() => setEditing(field)}
    >
      {editing === field ? (
        <input
          autoFocus
          type={type}
          value={values[field]}
          aria-label={field === "quantity" ? "Quantity" : field === "unitPrice" ? "Unit price" : field}
          onChange={(e) => setValues((p) => ({ ...p, [field]: e.target.value }))}
          onBlur={() => handleBlur(field)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setValues((p) => ({ ...p, [field]: (item as unknown as Record<string, string>)[field] }));
              setEditing(null);
            }
          }}
          className={`w-full bg-transparent border-b border-brand-red text-sm focus-visible:ring-2 focus-visible:ring-[#CC0000] focus-visible:ring-offset-1 ${align === "right" ? "text-right" : ""}`}
        />
      ) : (
        <span className="cursor-text hover:text-brand-red transition-colors block">
          {field === "unitPrice" ? fmt(values[field]) : values[field]}
        </span>
      )}
    </td>
  );

  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/20">
      <td className="px-4 py-2" onClick={() => setEditing("description")}>
        {editing === "description" ? (
          <input
            autoFocus
            value={values.description}
            aria-label="Line item description"
            onChange={(e) => setValues((p) => ({ ...p, description: e.target.value }))}
            onBlur={() => handleBlur("description")}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setValues((p) => ({ ...p, description: item.description }));
                setEditing(null);
              }
            }}
            className="w-full bg-transparent border-b border-brand-red text-sm focus-visible:ring-2 focus-visible:ring-[#CC0000] focus-visible:ring-offset-1"
          />
        ) : (
          <span className="cursor-text hover:text-brand-red transition-colors block text-sm">
            {values.description}
          </span>
        )}
      </td>
      <EditableCell field="quantity" align="right" type="number" />
      <EditableCell field="unit" />
      <EditableCell field="unitPrice" align="right" type="number" />
      <td className="px-3 py-2 text-right text-sm font-medium">{fmt(computedTotal)}</td>
      <td className="px-2 py-2 text-center">
        <button
          onClick={onDelete}
          className="text-muted-foreground hover:text-red-600 transition-colors p-2.5 rounded min-h-[44px] min-w-[44px] flex items-center justify-center"
          aria-label="Delete item"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}
