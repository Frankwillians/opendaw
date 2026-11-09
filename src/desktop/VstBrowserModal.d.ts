interface VstBrowserModalProps {
    onPick: (path: string, name: string) => void;
    onClose: () => void;
}
export default function VstBrowserModal({ onPick, onClose, }: VstBrowserModalProps): React.JSX.Element;
export {};
