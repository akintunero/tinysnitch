import { type VariantProps, cva } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-sm border text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        // The one action a page wants: the accent colour, never the plain ink, so it reads as a choice and not as a heading.
        primary: "border-accent bg-accent text-on-accent shadow-[inset_0_-1px_0_rgb(0_0_0/0.18)] hover:brightness-110",
        secondary: "border-line bg-surface text-ink hover:border-muted hover:bg-surface-2",
        ghost: "border-transparent text-soft hover:bg-surface-2 hover:text-ink",
      },
      size: { sm: "h-7 px-2.5", md: "h-8 px-3.5" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(button({ variant, size }), className)} {...props} />;
}
