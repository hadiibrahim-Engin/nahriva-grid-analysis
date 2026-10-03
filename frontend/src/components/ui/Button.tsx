import React from 'react'

type ButtonProps = {
  children: React.ReactNode
  onClick?: () => void
  className?: string
  variant?: 'primary' | 'secondary'
}

export default function Button({ children, onClick, className = '', variant = 'primary' }: ButtonProps) {
  const style =
    variant === 'primary'
      ? { backgroundColor: 'var(--color-cta)', color: '#fff' }
      : { backgroundColor: 'transparent', border: '2px solid var(--color-primary)', color: 'var(--color-primary)' }

  return (
    <button
      onClick={onClick}
      style={style}
      className={`px-4 py-2 rounded-md font-semibold transition-transform duration-200 hover:opacity-95 ${className}`}
    >
      {children}
    </button>
  )
}
