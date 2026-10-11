import { Icon } from '../ui/Icon';

export function ModelMenuColumns() {
  return (
    <div className="composer-model-columns" aria-hidden="true">
      <span>Model</span>
      <span className="composer-model-option-meta"><span>Context</span><span>Price</span></span>
    </div>
  );
}

/** One row layout for API catalogs, CLI catalogs, and their default/current choices. */
export function ModelMenuDetails({ name, context, price, priceTitle, tag }: {
  name: string;
  context?: string;
  price?: string;
  priceTitle?: string;
  tag?: 'Default' | 'Current';
}) {
  return (
    <>
      <span className="composer-model-option-heading">
        <Icon name="sparkles" size={14} />
        <span className="composer-model-option-name">{name}</span>
        {tag && <span className="composer-model-badge">{tag}</span>}
      </span>
      <span className="composer-model-option-meta">
        {context && <span className="composer-model-badge is-context">{context}</span>}
        {price && <span className="composer-model-badge is-cost" title={priceTitle}>{price}</span>}
      </span>
    </>
  );
}
