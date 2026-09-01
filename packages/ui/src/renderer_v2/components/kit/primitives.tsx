/**
 * The remaining kit primitives (v3.6.0): Badge, Card, StatusDot, Input,
 * Section. All cva variants over plain CSS classes in kit.scss.
 */
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './index'

/* ---- Badge --------------------------------------------------- */
const badgeVariants = cva('kit-badge', {
  variants: {
    variant: {
      neutral: 'kit-badge--neutral',
      primary: 'kit-badge--primary',
      success: 'kit-badge--success',
      warning: 'kit-badge--warning',
      danger: 'kit-badge--danger',
      outline: 'kit-badge--outline',
    },
  },
  defaultVariants: { variant: 'neutral' },
})

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

/* ---- Card ---------------------------------------------------- */
const cardVariants = cva('kit-card', {
  variants: {
    raised: { true: 'kit-card--raised', false: '' },
    glow: { true: 'kit-card--glow', false: '' },
  },
  defaultVariants: { raised: false, glow: false },
})

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

export function Card({ className, raised, glow, ...props }: CardProps) {
  return (
    <div className={cn(cardVariants({ raised, glow }), className)} {...props} />
  )
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('kit-card__header', className)} {...props} />
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('kit-card__title', className)} {...props} />
}
export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('kit-card__body', className)} {...props} />
}
export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('kit-card__footer', className)} {...props} />
}

/* ---- StatusDot ----------------------------------------------- */
const dotVariants = cva('kit-dot', {
  variants: {
    status: {
      success: 'kit-dot--success',
      warning: 'kit-dot--warning',
      danger: 'kit-dot--danger',
      neutral: 'kit-dot--neutral',
    },
    pulse: { true: 'kit-dot--pulse', false: '' },
  },
  defaultVariants: { status: 'neutral', pulse: false },
})

export interface StatusDotProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof dotVariants> {}

export function StatusDot({ className, status, pulse, ...props }: StatusDotProps) {
  return (
    <span className={cn(dotVariants({ status, pulse }), className)} {...props} />
  )
}

/* ---- Input --------------------------------------------------- */
const inputVariants = cva('kit-input', {
  variants: {
    invalid: { true: 'kit-input--invalid', false: '' },
  },
  defaultVariants: { invalid: false },
})

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(inputVariants({ invalid }), className)}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

/* ---- Section ------------------------------------------------- */
export interface SectionProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string
  hint?: string
}

export function Section({ className, title, hint, children, ...props }: SectionProps) {
  return (
    <div className={cn('kit-section', className)} {...props}>
      {title !== undefined && (
        <div className="kit-section__head">
          <h4 className="kit-section__title">{title}</h4>
        </div>
      )}
      {hint !== undefined && <p className="kit-section__hint">{hint}</p>}
      {children}
    </div>
  )
}

export { badgeVariants, cardVariants, dotVariants, inputVariants }