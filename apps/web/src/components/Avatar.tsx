import { accentFor, initialsFor } from '@initiative/shared';

interface AvatarProps {
  name: string;
  id?: string;
  url?: string | null;
  size?: number;
  online?: boolean;
  emoji?: string;
}

export function Avatar({ name, id, url, size = 44, online, emoji }: AvatarProps) {
  const background = emoji ? 'var(--surface-2)' : accentFor(id ?? name);
  return (
    <span style={{ position: 'relative', display: 'inline-block', flex: 'none' }}>
      {url ? (
        <img
          className="avatar"
          src={url}
          alt={name}
          width={size}
          height={size}
          style={{ width: size, height: size }}
          loading="lazy"
        />
      ) : (
        <span
          className="avatar"
          aria-hidden="true"
          style={{ width: size, height: size, background, fontSize: size * 0.38 }}
        >
          {emoji ?? initialsFor(name)}
        </span>
      )}
      {/*
          Der Punkt sagt, was er bedeutet.

          Der einzige Unterschied zwischen „da" und „nicht da" war die Farbe –
          grün gegen grau. Wer die Bedeutung nicht kennt oder die beiden Töne
          nicht trennen kann, bekam keinerlei Auskunft, und die Vorlesehilfe
          übersprang ihn ganz.
      */}
      {online != null && (
        <span
          role="img"
          aria-label={online ? 'Gerade in der App' : 'Gerade nicht in der App'}
          data-tipp={online ? 'Gerade in der App' : 'Gerade nicht in der App'}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: Math.max(9, size * 0.24),
            height: Math.max(9, size * 0.24),
            borderRadius: '50%',
            background: online ? 'var(--success)' : 'var(--text-faint)',
            border: '2px solid var(--bg)',
          }}
        />
      )}
    </span>
  );
}
