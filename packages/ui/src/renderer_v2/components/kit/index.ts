/**
 * Primitive UI kit — the openship-style component layer (v3.6.0).
 *
 * Built on class-variance-authority + clsx against the semantic design
 * tokens in styles/tokens.scss. No Tailwind (works with plain CSS vars),
 * no runtime deps beyond cva/clsx.
 *
 * MIGRATION RULE: components ported to this kit consume ONLY the semantic
 * token names (--color-*, --space-*, --radius-*, --text-*) — never raw
 * values and never the legacy --app-bg/--accent names.
 */
import { clsx } from 'clsx'

export const cn = (...args: Parameters<typeof clsx>) => clsx(...args)

export type { VariantProps } from 'class-variance-authority'

export { Button, buttonVariants, type ButtonProps } from './Button'
export {
  Badge, Card, CardHeader, CardTitle, CardBody, CardFooter,
  StatusDot, Input, Section,
  badgeVariants, cardVariants, dotVariants, inputVariants,
  type BadgeProps, type CardProps, type StatusDotProps, type InputProps, type SectionProps,
} from './primitives'