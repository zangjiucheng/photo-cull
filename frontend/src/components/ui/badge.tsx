import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type BadgeVariant = "default" | "secondary" | "outline" | "success" | "danger";

const variants: Record<BadgeVariant, string> = {
  default: "ui-badge-default",
  secondary: "",
  outline: "",
  success: "ui-badge-success",
  danger: "ui-badge-danger"
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return <span className={cn("ui-badge", variants[variant], className)} {...props} />;
}
