import { useTranslation } from 'react-i18next';
import PageContainer from '../Layout/PageContainer';
import UnfairPlayPanel from './UnfairPlayPanel';

export default function UnfairPlayPage() {
  const { t } = useTranslation();
  return (
    <PageContainer title="UnfairPlay">
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">{t('unfairplay.originals')}</p>
      <UnfairPlayPanel />
    </PageContainer>
  );
}
