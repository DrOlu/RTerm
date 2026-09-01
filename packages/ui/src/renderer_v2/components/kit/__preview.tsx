/**
 * __preview — a dev-only kit gallery. NOT imported by the app; exists so a
 * human can eyeball every primitive variant in one screen during dev:
 *   temporarily import { KitPreview } from './components/kit/__preview'
 * Never shipped (the __ prefix + the note below).
 */

import { Button, Badge, Card, CardHeader, CardTitle, CardBody, CardFooter,
  StatusDot, Input, Section } from './index'

export function KitPreview() {
  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 720 }}>
      <h2>Kit Preview</h2>

      <Section title="Buttons — variants × sizes">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="link">Link</Button>
          <Button size="xs">XS</Button>
          <Button size="sm">SM</Button>
          <Button size="lg">LG</Button>
          <Button size="icon">⚙</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Badges">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Badge>neutral</Badge>
          <Badge variant="primary">primary</Badge>
          <Badge variant="success">success</Badge>
          <Badge variant="warning">warning</Badge>
          <Badge variant="danger">danger</Badge>
          <Badge variant="outline">outline</Badge>
        </div>
      </Section>

      <Section title="Status dots">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><StatusDot status="success" /> healthy</span>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><StatusDot status="warning" /> degraded</span>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><StatusDot status="danger" /> down</span>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><StatusDot status="neutral" /> idle</span>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><StatusDot status="success" pulse /> live</span>
        </div>
      </Section>

      <Card raised glow>
        <CardHeader>
          <CardTitle>A raised, glowing card</CardTitle>
          <Badge variant="primary">kit</Badge>
        </CardHeader>
        <CardBody>
          <p style={{ margin: 0, color: 'var(--color-fg-muted)' }}>
            Cards compose from the same tokens. This one is raised + glow.
          </p>
          <Input placeholder="A kit input — focus me to see the ring" style={{ marginTop: 12 }} />
          <Input invalid defaultValue="an invalid input" style={{ marginTop: 8 }} />
        </CardBody>
        <CardFooter>
          <Button variant="ghost" size="sm">Cancel</Button>
          <Button variant="primary" size="sm">Save</Button>
        </CardFooter>
      </Card>
    </div>
  )
}