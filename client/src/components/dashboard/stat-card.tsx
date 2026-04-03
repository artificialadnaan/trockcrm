import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  trend?: { value: number; label: string; positive?: boolean };
  className?: string;
  valueClassName?: string;
}

export function StatCard({ title, value, subtitle, icon, trend, className = "", valueClassName = "text-2xl" }: StatCardProps) {
  return (
    <Card className={className}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className={`${valueClassName} font-bold`}>{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
            {trend && (
              <p className={`text-xs font-medium ${trend.positive ? "text-emerald-600" : "text-red-600"}`}>
                {trend.positive ? "+" : ""}{trend.value}% {trend.label}
              </p>
            )}
          </div>
          {icon && (
            <div className="text-muted-foreground">{icon}</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
