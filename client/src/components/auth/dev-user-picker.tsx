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
            <span className="text-brand-purple font-bold">T Rock CRM</span>
            <p className="text-sm text-muted-foreground mt-1">Dev Mode -- Select a user</p>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {users.map((user) => (
            <Button
              key={user.id}
              variant="outline"
              className="w-full justify-between h-auto py-3"
              onClick={() => login(user.email)}
            >
              <span>{user.displayName}</span>
              <Badge variant="secondary">{user.role}</Badge>
            </Button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
