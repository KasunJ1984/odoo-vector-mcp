const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// Read the Excel file from the other project
const excelPath = path.join(__dirname, '..', 'odoo-crm-mcp-server', 'odoo-crm-mcp-server', 'schema table.xlsx');
console.log('Reading Excel file:', excelPath);

const workbook = XLSX.readFile(excelPath);
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];

// Convert to JSON (array of arrays)
const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

console.log('Total rows (including header):', data.length);

// Skip header row, write data rows to file
const outputPath = path.join(__dirname, 'data', 'odoo_schema.txt');
let output = '';
let count = 0;

for (let i = 1; i < data.length; i++) {
  const row = data[i];
  if (row && row.length > 0 && row[0]) {
    // Each row is already in the encoded format as a single cell
    const encodedRow = String(row[0]).trim();
    if (encodedRow) {
      output += encodedRow + '\n';
      count++;
    }
  }
}

fs.writeFileSync(outputPath, output);
console.log('Exported', count, 'schema rows to:', outputPath);

// Show first few rows for verification
console.log('\n=== SAMPLE DATA (first 3 rows) ===');
const lines = output.split('\n').slice(0, 3);
lines.forEach((line, i) => {
  console.log(`Row ${i + 1}:`, line.substring(0, 100) + '...');
});
