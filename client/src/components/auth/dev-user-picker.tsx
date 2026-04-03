import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface DevUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

const ROLE_CONFIG: Record<string, { label: string; avatarClass: string; badgeClass: string }> = {
  admin: {
    label: "Admin — Full Access",
    avatarClass: "bg-red-100 text-red-700",
    badgeClass: "bg-red-100 text-red-700 border-red-200",
  },
  director: {
    label: "Director — Team Management",
    avatarClass: "bg-blue-100 text-blue-700",
    badgeClass: "bg-blue-100 text-blue-700 border-blue-200",
  },
  rep: {
    label: "Sales Rep — Deal Pipeline",
    avatarClass: "bg-green-100 text-green-700",
    badgeClass: "bg-green-100 text-green-700 border-green-200",
  },
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function DevUserPicker() {
  const { login } = useAuth();
  const [users, setUsers] = useState<DevUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ users: DevUser[] }>("/auth/dev/users")
      .then((data) => setUsers(data.users))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex items-center justify-center min-h-screen">Loading...</div>;

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-50">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center">
            <span className="text-brand-red font-bold text-xl">T Rock CRM</span>
            <p className="text-xs font-normal text-muted-foreground mt-0.5 tracking-wide uppercase">
              Construction CRM Platform
            </p>
            <p className="text-sm text-muted-foreground mt-3">Dev Mode — Select a user</p>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {users.map((user) => {
            const config = ROLE_CONFIG[user.role] ?? {
              label: user.role,
              avatarClass: "bg-gray-100 text-gray-700",
              badgeClass: "bg-gray-100 text-gray-700 border-gray-200",
            };
            return (
              <Button
                key={user.id}
                variant="outline"
                className="w-full justify-start h-auto py-3 gap-3"
                onClick={() => login(user.email)}
              >
                <div
                  className={`h-9 w-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${config.avatarClass}`}
                >
                  {getInitials(user.displayName)}
                </div>
                <div className="flex-1 text-left">
                  <p className="font-medium text-sm">{user.displayName}</p>
                  <p className="text-xs text-muted-foreground">{config.label}</p>
                </div>
                <Badge
                  variant="outline"
                  className={`text-xs shrink-0 ${config.badgeClass}`}
                >
                  {user.role}
                </Badge>
              </Button>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
