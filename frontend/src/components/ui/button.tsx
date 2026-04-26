import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
type ButtonSize = "default" | "sm" | "lg" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  default: "ui-btn-default",
  secondary: "ui-btn-secondary",
  outline: "ui-btn-outline",
  ghost: "ui-btn-ghost",
  destructive: "ui-btn-destructive"
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "ui-btn-md",
  sm: "ui-btn-sm",
  lg: "ui-btn-lg",
  icon: "ui-btn-icon"
};

export function Button({ className, variant = "default", size = "default", ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "ui-btn",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    />
  );
}
