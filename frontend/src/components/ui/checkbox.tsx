import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Checkbox({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        "ui-checkbox",
        className
      )}
      {...props}
    />
  );
}
