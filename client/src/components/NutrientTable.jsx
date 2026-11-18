import { NUTRIENT_DEFS, formatNumber } from '@shared/nutrients.js';

export function NutrientTable({ nutrients, extras = [] }) {
  const available = NUTRIENT_DEFS.filter((def) => nutrients?.[def.key] != null);
  const missing = NUTRIENT_DEFS.filter((def) => nutrients?.[def.key] == null);
  return (
    <div className="nutrient-table">
      <table>
        <tbody>
          {available.map((def) => (
            <tr key={def.key}>
              <th scope="row">{def.label}</th>
              <td>{formatNumber(nutrients[def.key].amount, def.unit)} {def.unit}</td>
            </tr>
          ))}
          {extras.map((item) => (
            <tr key={`${item.key}-${item.unit}`}>
              <th scope="row">{item.label}</th>
              <td>{formatNumber(item.amount, item.unit)} {item.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {missing.length > 0 && (
        <p className="missing">Not provided: {missing.map((def) => def.label).join(', ')}. Empty values were not treated as zero.</p>
      )}
    </div>
  );
}
