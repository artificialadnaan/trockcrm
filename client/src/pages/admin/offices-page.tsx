import { useState } from "react";
import { Building2, Plus, RefreshCw, CheckCircle2, XCircle, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAdminOffices, type Office } from "@/hooks/use-admin-offices";

export function OfficesPage() {
  const { offices, loading, error, refetch, createOffice, updateOffice } = useAdminOffices();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "", address: "", phone: "" });
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [noTouchDaysInput, setNoTouchDaysInput] = useState<Record<string, string>>({});
  const [noTouchSaving, setNoTouchSaving] = useState<Record<string, boolean>>({});
  const [noTouchSaved, setNoTouchSaved] = useState<Record<string, boolean>>({});

  const getNoTouchDays = (office: Office): number => {
    const v = (office.settings as Record<string, unknown>)?.contactNoTouchDays;
    return typeof v === "number" && v >= 1 ? Math.floor(v) : 60;
  };

  const handleNoTouchSave = async (office: Office) => {
    const raw = noTouchDaysInput[office.id];
    const parsed = raw !== undefined ? parseInt(raw, 10) : getNoTouchDays(office);
    if (isNaN(parsed) || parsed < 7 || parsed > 365) return;
    setNoTouchSaving((s) => ({ ...s, [office.id]: true }));
    try {
      await updateOffice(office.id, {
        settings: { ...(office.settings as Record<string, unknown>), contactNoTouchDays: parsed },
      });
      setNoTouchSaved((s) => ({ ...s, [office.id]: true }));
      setNoTouchDaysInput((s) => { const next = { ...s }; delete next[office.id]; return next; });
      setTimeout(() => setNoTouchSaved((s) => ({ ...s, [office.id]: false })), 2000);
    } catch (err) {
      console.error("Failed to save contact no-touch threshold:", err);
    } finally {
      setNoTouchSaving((s) => ({ ...s, [office.id]: false }));
    }
  };

  const handleCreate = async () => {
    setCreateError(null);
    setSaving(true);
    try {
      await createOffice({
        name: form.name.trim(),
        slug: form.slug.trim().toLowerCase().replace(/\s+/g, "_"),
        address: form.address.trim() || undefined,
        phone: form.phone.trim() || undefined,
      });
      setShowCreate(false);
      setForm({ name: "", slug: "", address: "", phone: "" });
    } catch (err: any) {
      setCreateError(err.message ?? "Failed to create office");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (office: Office) => {
    await updateOffice(office.id, { isActive: !office.isActive });
  };

  const handleNameChange = (name: string) => {
    const slug = name.toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    setForm((f) => ({ ...f, name, slug }));
  };

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Offices</h1>
          <p className="text-sm text-gray-500 mt-1">
            Each office gets its own isolated database schema
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New Office
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug (Schema)</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {offices.map((office) => (
              <TableRow key={office.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-gray-400" />
                    {office.name}
                  </div>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded font-mono">
                    office_{office.slug}
                  </code>
                </TableCell>
                <TableCell className="text-sm text-gray-600">{office.address ?? "\u2014"}</TableCell>
                <TableCell className="text-sm text-gray-600">{office.phone ?? "\u2014"}</TableCell>
                <TableCell>
                  <Badge
                    className={
                      office.isActive
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-500"
                    }
                  >
                    {office.isActive ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={
                      office.isActive
                        ? "text-red-600 hover:bg-red-50"
                        : "text-green-600 hover:bg-green-50"
                    }
                    onClick={() => toggleActive(office)}
                  >
                    {office.isActive ? (
                      <><XCircle className="h-4 w-4 mr-1" />Deactivate</>
                    ) : (
                      <><CheckCircle2 className="h-4 w-4 mr-1" />Activate</>
                    )}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {offices.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-gray-400 py-8">
                  No offices yet
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Contact Alert Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-gray-500" />
            <CardTitle className="text-base">Contact Alert Settings</CardTitle>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Configure how many days without contact before a cold lead warming task is created.
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {offices.map((office) => {
              const current = getNoTouchDays(office);
              const inputVal = noTouchDaysInput[office.id] ?? String(current);
              const isDirty = noTouchDaysInput[office.id] !== undefined && noTouchDaysInput[office.id] !== String(current);
              const parsed = parseInt(inputVal, 10);
              const isValid = !isNaN(parsed) && parsed >= 7 && parsed <= 365;
              return (
                <div key={office.id} className="flex items-center gap-4">
                  <div className="w-40 shrink-0">
                    <p className="text-sm font-medium text-gray-900">{office.name}</p>
                    <p className="text-xs text-gray-400 font-mono">office_{office.slug}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={7}
                      max={365}
                      className="w-24"
                      value={inputVal}
                      onChange={(e) =>
                        setNoTouchDaysInput((s) => ({ ...s, [office.id]: e.target.value }))
                      }
                    />
                    <Label className="text-sm text-gray-600">days</Label>
                  </div>
                  <Button
                    size="sm"
                    variant={noTouchSaved[office.id] ? "outline" : "default"}
                    disabled={!isDirty || !isValid || noTouchSaving[office.id]}
                    onClick={() => handleNoTouchSave(office)}
                  >
                    {noTouchSaving[office.id]
                      ? "Saving..."
                      : noTouchSaved[office.id]
                      ? "Saved"
                      : "Save"}
                  </Button>
                  {!isValid && noTouchDaysInput[office.id] !== undefined && (
                    <p className="text-xs text-red-500">Must be between 7 and 365</p>
                  )}
                </div>
              );
            })}
            {offices.length === 0 && !loading && (
              <p className="text-sm text-gray-400">No active offices.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Office</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {createError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
                {createError}
              </div>
            )}
            <div>
              <Label htmlFor="name">Office Name</Label>
              <Input
                id="name"
                placeholder="Dallas"
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="slug">Slug (schema name)</Label>
              <div className="flex items-center gap-1 mt-1">
                <span className="text-sm text-gray-400 font-mono">office_</span>
                <Input
                  id="slug"
                  placeholder="dallas"
                  value={form.slug}
                  onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                  className="font-mono"
                />
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Lowercase letters, numbers, underscores only. Cannot be changed after creation.
              </p>
            </div>
            <div>
              <Label htmlFor="address">Address (optional)</Label>
              <Input
                id="address"
                placeholder="123 Main St, Dallas, TX 75001"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="phone">Phone (optional)</Label>
              <Input
                id="phone"
                placeholder="(214) 555-0100"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={saving || !form.name.trim() || !form.slug.trim()}
            >
              {saving ? "Creating..." : "Create Office"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
