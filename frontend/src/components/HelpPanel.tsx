import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { CircleHelp } from 'lucide-react';
import { buildMailtoHref, useUiConfig } from '../config/uiConfig';
import { useFloatingPanel } from '../util/floatingPanels';
import AnimatedButton from './ui/AnimatedButton';

export default function HelpPanel() {
  const { isOpen: open, open: showPanel, close: hidePanel, toggle } = useFloatingPanel('help');
  const shouldReduceMotion = useReducedMotion();
  const uiConfig = useUiConfig();
  const supportEmails = uiConfig.support.emails.length > 0 ? uiConfig.support.emails : [uiConfig.support.email];
  const [mailActionStatus, setMailActionStatus] = useState('');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openMailApp = async () => {
    setMailActionStatus('');
    const emailText = supportEmails.join(', ');
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Kontakt & Support',
          text: `Support E-Mail: ${emailText}`,
        });
        return;
      }

      await navigator.clipboard.writeText(emailText);
      setMailActionStatus('E-Mail-Adresse kopiert.');
    } catch {
      setMailActionStatus(`E-Mail: ${emailText}`);
    }
  };

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(hidePanel, 180);
  };

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    const openFromHeader = () => {
      showPanel();
    };

    window.addEventListener('grid-help-open', openFromHeader);
    return () => window.removeEventListener('grid-help-open', openFromHeader);
  }, [showPanel]);

  return (
    <div
      className="fixed bottom-4 right-[15.5rem] z-[950]"
      onPointerEnter={() => { cancelClose(); showPanel(); }}
      onPointerLeave={scheduleClose}
      onFocus={() => { cancelClose(); showPanel(); }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          scheduleClose();
        }
      }}
    >
      {/* Trigger button */}
      <div>
        <AnimatedButton
          variant="primary"
          size="sm"
          onClick={toggle}
          title="Hilfe & Support"
          icon={<CircleHelp size={14} strokeWidth={2.2} />}
          className="w-[5.5rem] shadow-lg"
        >
          Hilfe
        </AnimatedButton>
      </div>

      {/* Drawer */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="help-panel"
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="absolute bottom-10 right-0 w-[calc(100vw-2rem)] max-w-[420px] max-h-[60vh] rounded-xl shadow-2xl flex flex-col overflow-hidden"
            style={{
              background: 'var(--grid-surface)',
              border: '1px solid var(--grid-border)',
            }}
          >
            {/* header */}
            <div
              className="flex items-center justify-between px-4 py-3 shrink-0"
              style={{
                background: 'var(--grid-header)',
                borderBottom: '1px solid var(--grid-border)',
              }}
            >
              <div>
                <div className="text-sm font-bold" style={{ color: 'var(--grid-text)' }}>
                  Kontakt & Support
                </div>
                <div className="text-[11px]" style={{ color: 'var(--grid-muted)' }}>
                  Fragen, Wünsche oder Ideen?
                </div>
              </div>
              <AnimatedButton
                variant="ghost"
                size="xs"
                onClick={hidePanel}
                aria-label="Schließen"
              >
                ✕
              </AnimatedButton>
            </div>

            {/* body */}
            <div
              className="p-4 text-sm overflow-auto flex-1"
              style={{ color: 'var(--grid-text-soft)' }}
            >
              <div className="space-y-3">
                <p className="text-sm">Haben Sie neue Ideen, Wünsche oder Feedback zum Dashboard?</p>

                <div className="rounded-lg border border-[var(--grid-border)] bg-[var(--grid-bg)] p-3">
                  <div className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--grid-primary)' }}>
                    E-Mail
                  </div>
                  <div className="space-y-2">
                    {supportEmails.map((email) => (
                      <a
                        key={email}
                        href={buildMailtoHref(email)}
                        className="block break-all text-xs underline"
                        style={{ color: 'var(--grid-primary)' }}
                      >
                        {email}
                      </a>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={openMailApp}
                  className="inline-flex rounded-md bg-[var(--grid-primary)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                >
                  E-Mail-App wählen
                </button>
                {mailActionStatus && (
                  <div className="text-xs" style={{ color: 'var(--grid-muted)' }}>
                    {mailActionStatus}
                  </div>
                )}
              </div>

              <hr className="my-3" style={{ borderColor: 'var(--grid-border)' }} />

              <div className="text-xs" style={{ color: 'var(--grid-muted)' }}>
                © 2026 {uiConfig.legal.companyName}. {uiConfig.legal.rightsText}
              </div>
              <div className="mt-2 text-xs" style={{ color: 'var(--grid-muted)' }}>
                {uiConfig.legal.fullConfidentialityText}
              </div>
              <div className="mt-2 text-xs" style={{ color: 'var(--grid-muted)' }}>
                Bei Fragen zur Nutzung, zu Zugriffsrechten oder Berechtigungen wenden Sie
                sich bitte an den oben genannten Kontakt.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
