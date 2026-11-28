import { Injectable } from '@nestjs/common';
import { AppException } from '@teachhub/core';
import type { Tx } from '@teachhub/db';
import type {
  AbsenceRequest,
  AbsenceRequestList,
  CreateAbsenceRequest,
} from '../http/family.schemas.js';

/** Hợp đồng trước (thân hàm ở commit sau). */
@Injectable()
export class AbsenceRequestsService {
  create(
    _t: Tx,
    _userId: string,
    _body: CreateAbsenceRequest,
  ): Promise<{ created: boolean; request: AbsenceRequest }> {
    return Promise.reject(new AppException('NOT_IMPLEMENTED'));
  }

  list(_userId: string, _studentId: string): Promise<AbsenceRequestList> {
    return Promise.reject(new AppException('NOT_IMPLEMENTED'));
  }

  cancel(_userId: string, _id: string): Promise<void> {
    return Promise.reject(new AppException('NOT_IMPLEMENTED'));
  }
}
