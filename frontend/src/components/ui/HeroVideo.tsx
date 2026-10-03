import Button from './Button'

type HeroVideoProps = {
  videoSrc?: string
  poster?: string
  title?: string
  subtitle?: string
}

export default function HeroVideo({ videoSrc, poster, title, subtitle }: HeroVideoProps) {
  return (
    <section className="relative w-full overflow-hidden">
      {videoSrc ? (
        <video
          className="w-full h-[60vh] object-cover"
          src={videoSrc}
          poster={poster}
          autoPlay
          muted
          loop
          playsInline
        />
      ) : (
        <div className="w-full h-[60vh] bg-gradient-to-br from-[#071126] to-[#0b1220]" />
      )}

      <div className="absolute inset-0 flex items-center justify-center">
        <div className="max-w-4xl text-center p-6" style={{ color: 'var(--color-text)' }}>
          <h1 className="text-4xl font-bold mb-4 drop-shadow-md" style={{ textShadow: '0 0 10px rgba(0,0,0,0.4)' }}>
            {title ?? 'Welcome to DashB'}
          </h1>
          <p className="text-lg mb-6 opacity-90">{subtitle ?? 'Beautiful dashboards, faster insights.'}</p>
          <Button variant="primary">Get Started</Button>
        </div>
      </div>

      <div className="absolute inset-0 bg-black/40" aria-hidden />
    </section>
  )
}
