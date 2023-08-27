/* eslint-disable no-param-reassign */
import { PostgresAdapter } from './types';
import { ArrayRowToInsert } from './transform/write/types';

type Args = {
  adapter: PostgresAdapter
  arrays: {
    [tableName: string]: ArrayRowToInsert[]
  }[]
  parentRows: Record<string, unknown>[]
}

type RowsByTable = {
  [tableName: string]: {
    arrays: {
      [tableName: string]: ArrayRowToInsert[]
    }[]
    columnName: string
    localeRowIndexMap: [number, number][]
    locales: Record<string, unknown>[]
    rowIndexMap: [number, number][]
    rows: Record<string, unknown>[]
  }
}

// We want to insert ALL array rows per table with a single insertion
// rather than inserting each array row separately.
// To do this, we take in an array of arrays by table name and parent rows
// Parent rows and the array of arrays need to be the same length
// so we can "hoist" the created array rows back into the parent rows
export const insertArrays = async ({
  adapter,
  arrays,
  parentRows,
}: Args): Promise<void> => {
  // Maintain a map of flattened rows by table
  const rowsByTable: RowsByTable = {};

  arrays.forEach((arraysByTable, parentRowIndex) => {
    Object.entries(arraysByTable).forEach(([tableName, arrayRows]) => {
      // If the table doesn't exist in map, initialize it
      if (!rowsByTable[tableName]) {
        rowsByTable[tableName] = {
          columnName: arrayRows[0]?.columnName,
          arrays: [],
          localeRowIndexMap: [],
          locales: [],
          rowIndexMap: [],
          rows: [],
        };
      }

      const parentID = parentRows[parentRowIndex].id;

      // We store row indexes to "slice out" the array rows
      // that belong to each parent row
      rowsByTable[tableName].rowIndexMap.push([
        rowsByTable[tableName].rows.length, rowsByTable[tableName].rows.length + arrayRows.length,
      ]);

      // Add any sub arrays that need to be created
      // We will call this recursively below
      arrayRows.forEach((arrayRow, arrayRowIndex) => {
        if (Object.keys(arrayRow.arrays).length > 0) {
          rowsByTable[tableName].arrays.push(arrayRow.arrays);
        }

        // Set up parent IDs for both row and locale row
        arrayRow.row._parentID = parentID;
        rowsByTable[tableName].rows.push(arrayRow.row);

        const existingLocaleCount = rowsByTable[tableName].locales.length;

        Object.entries(arrayRow.locales).forEach(([arrayRowLocale, arrayRowLocaleData]) => {
          arrayRowLocaleData._parentID = arrayRow.row.id;
          arrayRowLocaleData._locale = arrayRowLocale;
          rowsByTable[tableName].locales.push(arrayRowLocaleData);
        });

        rowsByTable[tableName].localeRowIndexMap[arrayRowIndex] = [
          existingLocaleCount,
          existingLocaleCount + Object.keys(arrayRow.locales).length,
        ];
      });
    });
  });

  // Insert all corresponding arrays in parallel
  // (one insert per array table)
  await Promise.all(Object.entries(rowsByTable).map(async (
    [tableName, row],
  ) => {
    const insertedRows = await adapter.db.insert(adapter.tables[tableName])
      .values(row.rows).returning();

    let insertedLocaleRows: Record<string, unknown>[] = [];

    // Insert locale rows
    if (adapter.tables[`${tableName}_locales`]) {
      insertedLocaleRows = await adapter.db.insert(adapter.tables[`${tableName}_locales`])
        .values(row.locales).returning();
    }

    rowsByTable[tableName].rows = insertedRows.map((arrayRow, i) => {
      if (Array.isArray(row.localeRowIndexMap[i])) {
        const sliceStart = row.localeRowIndexMap[i][0];
        const sliceEnd = row.localeRowIndexMap[i][1];
        const localeRows = insertedLocaleRows.slice(sliceStart, sliceEnd);

        if (localeRows.length > 0) {
          arrayRow._locales = localeRows;
        }
      }

      return arrayRow;
    });

    // If there are sub arrays, call this function recursively
    if (row.arrays.length > 0) {
      await insertArrays({
        adapter,
        arrays: row.arrays,
        parentRows: row.rows,
      });
    }
  }));

  // Finally, hoist up the newly inserted arrays to their parent row
  // by slicing out the appropriate range from rowIndexMap
  Object.values(rowsByTable).forEach(({ rows, columnName, rowIndexMap }) => {
    rowIndexMap.forEach(([start, finish], i) => {
      parentRows[i][columnName] = rows.slice(start, finish);
    });
  });
};
