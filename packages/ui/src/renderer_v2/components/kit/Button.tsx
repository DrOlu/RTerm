/**
 * Button — the variant-system primitive (v3.6.0).
 * cva variants mapping to plain CSS classes in kit.scss (NO Tailwind —
 * RTerm has no Tailwind build; arbitrary-value classes would be dead text).
 * The SCSS consumes only the semantic tokens.
 */
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './index'

const buttonVariants = cva('kit-button', {
  variants: {
    variant: {
      primary: 'kit-button--primary',
      secondary: 'kit-button--secondary',
      outline: 'kit-button--outline',
      ghost: 'kit-button--ghost',
      danger: 'kit-button--danger',
      link: 'kit-button--link',
    },
    size: {
      xs: 'kit-button--xs',
      sm: 'kit-button--sm',
      md: 'kit-button--md',
      lg: 'kit-button--lg',
      icon: 'kit-button--icon',
      'icon-lg': 'kit-button--icon-lg',
    },
  },
  defaultVariants: { variant: 'secondary', size: 'md' },
})

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
)
Button.displayName = 'Button'

export { buttonVariants }