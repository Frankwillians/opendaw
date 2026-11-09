interface Props {
    sampleRate: number;
    notify: (message: string) => void;
    onClose: () => void;
}
export default function PluginPanel({ sampleRate, notify, onClose }: Props): React.JSX.Element;
export {};
