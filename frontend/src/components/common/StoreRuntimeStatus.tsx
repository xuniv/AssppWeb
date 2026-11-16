import { useTranslation } from 'react-i18next';
import { useRuntimeStore } from '../../store/runtime';
import Spinner from './Spinner';

export default function StoreRuntimeStatus() {
  const stage = useRuntimeStore((state) => state.stage);
  const { t } = useTranslation();
  if (!stage) return null;
  return (
    <div
      role="status"
      className="mb-4 flex items-center gap-2 rounded-xl bg-blue-50 p-3 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-200"
    >
      <Spinner />
      {t(`runtime.${stage}`)}
    </div>
  );
}
