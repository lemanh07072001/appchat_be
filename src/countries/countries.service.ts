import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Country, CountryDocument } from '../schemas/countries.schema';
import { Model, Types } from 'mongoose';
import { CreateCountryDto } from '../dto/create-country.dto';
import { PaginationQueryDto } from '../dto/pagination-query.dto';

@Injectable()
export class CountriesService {
  constructor(
    @InjectModel(Country.name)
    private countryModel: Model<CountryDocument>,
  ) {}

  async findAll() {
    return await this.countryModel.find().exec();
  }

  async findAllPaginated(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const search = query.search ?? '';
    const skip = (page - 1) * limit;

    const orConditions: any[] = [
      { name: { $regex: search, $options: 'i' } },
      { code: { $regex: search, $options: 'i' } },
    ];

    if (Types.ObjectId.isValid(search)) {
      orConditions.push({ _id: new Types.ObjectId(search) });
    }

    const filter = search ? { $or: orConditions } : {};

    const [data, total] = await Promise.all([
      this.countryModel.find(filter).skip(skip).limit(limit).sort({ createdAt: -1 }).exec(),
      this.countryModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findAllList() {
    return this.countryModel.find().select('_id name code').exec();
  }

  async duplicate(id: string): Promise<CountryDocument> {
    const country = await this.countryModel.findById(id).exec();
    if (!country) {
      throw new BadRequestException('Country not found');
    }

    let copyName = `${country.name} (copy)`;
    let count = 1;
    while (await this.countryModel.findOne({ name: copyName }).exec()) {
      count++;
      copyName = `${country.name} (copy ${count})`;
    }

    const newCountry = new this.countryModel({
      name: copyName,
      code: country.code,
    });
    return newCountry.save();
  }

  async update(id: string, data: CreateCountryDto): Promise<CountryDocument> {
    const country = await this.countryModel.findById(id).exec();
    if (!country) {
      throw new BadRequestException('Country not found');
    }
    const existing = await this.countryModel.findOne({ name: data.name, _id: { $ne: id } }).exec();
    if (existing) {
      throw new BadRequestException('Country name already exists');
    }
    country.name = data.name;
    country.code = data.code;
    return country.save();
  }

  async delete(id: string) {
    const country = await this.countryModel.findByIdAndDelete(id).exec();
    if (!country) {
      throw new BadRequestException('Country not found');
    }
    return { message: 'Country deleted successfully' };
  }

  async deleteMany(ids: string[]) {
    const result = await this.countryModel.deleteMany({ _id: { $in: ids } }).exec();
    return { message: `${result.deletedCount} countries deleted successfully` };
  }

  async create(data: CreateCountryDto): Promise<CountryDocument> {
    const existing = await this.countryModel.findOne({ name: data.name }).exec();
    if (existing) {
      throw new BadRequestException('Country already exists');
    }
    const country = new this.countryModel(data);
    return country.save();
  }
}
