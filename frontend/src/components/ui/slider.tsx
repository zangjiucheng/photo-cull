import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Slider({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="range"
      className={cn("w-full accent-slate-900", className)}
      {...props}
    />
  );
}
